const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs').promises;
const { existsSync } = require('fs');
const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'flota.json');

app.use(compression());
app.use(express.json());
app.set('json spaces', 0);

let flota = [];
let pedestres = {}; // { userId: [lat, lng, name] }
let finishedTrips = 0;
const wss = new WebSocketServer({ server });

const DRIVERS_DB = {
  1: { nombre: "Juan Pérez", rating: 4.8, vehicle: "Toyota Prius", plate: "MP-456-X" },
  2: { nombre: "María García", rating: 4.9, vehicle: "Hyundai Ioniq", plate: "MP-122-A" },
  3: { nombre: "Carlos Ruiz", rating: 4.7, vehicle: "Kia Niro", plate: "MP-889-B" },
  4: { nombre: "Ana López", rating: 5.0, vehicle: "Tesla Model 3", plate: "OKY-001-Z" }
};

async function inicializar() {
  try {
    if (existsSync(DATA_FILE)) {
      const content = await fs.readFile(DATA_FILE, 'utf8');
      const data = JSON.parse(content);
      if (Array.isArray(data)) {
        flota = data;
      } else {
        flota = data.flota || [];
        finishedTrips = data.finishedTrips || 0;
      }
    } else {
      flota = Array.from({ length: 15 }, (_, i) => ({
        d: [i + 1, 3.7500 + (Math.random()*0.02), 8.7500 + (Math.random()*0.02), 1],
        m: Math.floor(Date.now() / 1000)
      }));
      await guardarDatos();
    }
  } catch (e) { console.error(e); }
}

async function guardarDatos() {
  try { 
    await fs.writeFile(DATA_FILE, JSON.stringify({ flota, finishedTrips })); 
  } catch (e) { console.error(e); }
}

function broadcast(updates, p_updates = null) {
  const msg = JSON.stringify({ 
    t: Math.floor(Date.now() / 1000), 
    u: updates,
    p: p_updates,
    fTrips: finishedTrips
  });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ 
    t: Math.floor(Date.now() / 1000), 
    f: 1, 
    c: flota.map(v => v.d),
    p: Object.entries(pedestres).map(([id, val]) => [id, ...val]),
    fTrips: finishedTrips
  }));
});

function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.post('/match-trip', (req, res) => {
  const { lat, lng, clientId } = req.body;
  if (!lat || !lng) return res.status(400).send();
  let closest = null;
  let minDistance = Infinity;
  flota.forEach(v => {
    if (v.d[3] === 1) { 
      const dist = calcularDistancia(lat, lng, v.d[1], v.d[2]);
      if (dist < minDistance) { minDistance = dist; closest = v; }
    }
  });
  if (closest) {
    const carId = closest.d[0];
    closest.d[3] = 2;
    
    // Vincular peatón con coche si se proporcionó ID
    if (clientId && pedestres[clientId]) {
      pedestres[clientId][3] = carId; // Guardamos carId en el índice 3
      broadcast([closest.d], [[clientId, ...pedestres[clientId]]]);
    } else {
      broadcast([closest.d]);
    }

    guardarDatos();
    setTimeout(() => {
      const current = flota.find(v => v.d[0] === carId);
      if (current && current.d[3] === 2) {
        current.d[3] = 1;
        // Limpiar vinculación al expirar
        if (clientId && pedestres[clientId]) delete pedestres[clientId][3];
        broadcast([current.d]);
        guardarDatos();
      }
    }, 60000);
    const info = DRIVERS_DB[carId] || { nombre: "Conductor " + carId, rating: 4.5, vehicle: "VTC Estándar", plate: "SN-00" + carId };
    return res.json({ carId, driver: info });
  }
  res.status(404).json({ error: "No hay coches disponibles" });
});

app.patch('/vehiculo/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const { lat, lng, st } = req.body;
  const v = flota.find(item => item.d[0] === id);
  if (!v) return res.status(404).send();
  if (lat !== undefined) v.d[1] = lat;
  if (lng !== undefined) v.d[2] = lng;
  
  let p_updates = null;
  if (st !== undefined) {
    if (v.d[3] === 5 && st === 1) finishedTrips++; // Incrementamos total cuando pasa de A bordo a Libre
    v.d[3] = st;
    // Si el estado es 5 (A bordo), buscamos y eliminamos al peatón vinculado para limpiar el mapa
    if (st === 5) {
      for (const pid in pedestres) {
        if (pedestres[pid][3] === id) {
          delete pedestres[pid];
          p_updates = [['DELETE', pid]]; // Informamos al admin del borrado
          break;
        }
      }
    }
  }
  
  broadcast([v.d], p_updates);
  await guardarDatos();
  res.json({ ok: 1 });
});

app.post('/client-pos', (req, res) => {
  const { id, lat, lng, name } = req.body;
  if (!id || !lat || !lng) return res.status(400).send();
  pedestres[id] = [lat, lng, name || "Cliente"];
  broadcast([], [[id, lat, lng, name || "Cliente"]]);
  res.json({ ok: 1 });
});

app.get('/administrador', (req, res) => res.sendFile(path.join(__dirname, 'views/administrador/index.html')));

app.get('/usuarios.json', (req, res) => res.sendFile(path.join(__dirname, 'usuarios.json')));

app.use('/conductor', express.static(path.join(__dirname, 'views/conductor')));
app.get('/conductor', (req, res) => res.sendFile(path.join(__dirname, 'views/conductor/index.html')));

app.use(express.static('views'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'views/index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/conductor/:id', (req, res) => res.sendFile(path.join(__dirname, 'views/conductor.html')));

inicializar().then(() => {
  server.listen(PORT, () => console.log('Servidor en http://localhost:' + PORT));
});
