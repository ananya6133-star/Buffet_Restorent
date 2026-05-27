import express from 'express';
import { createServer } from 'http';
import net from 'net';
import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, 'db.json');
// Initialize database in-memory cache
let db = {
  users: [],
  tables: [],
  menuItems: [],
  requests: [],
  feedback: [],
  notifications: []
};
// Load database from file
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(data);
      console.log('Database loaded successfully.');
    } else {
      console.log('Database file not found. Keeping default empty database.');
    }
  } catch (err) {
    console.error('Error loading database:', err);
  }
}
// Save database to file
function saveDB() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Error saving database:', err);
  }
}
// Helper: Generate Unique ID
function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
loadDB();
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Active WebSocket clients
const clients = new Set();
// Broadcast helper
function broadcast(message) {
  const data = JSON.stringify(message);
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}
// REST APIs
// 1. Authentication / Login
app.post('/api/auth/login', (req, res) => {
  const { username, role, tableNumber } = req.body;
  if (role === 'customer') {
    if (!tableNumber) {
      return res.status(400).json({ error: 'Table number is required for customers.' });
    }
    
    // Find or check table
    const tableNum = parseInt(tableNumber, 10);
    const table = db.tables.find(t => t.number === tableNum);
    if (!table) {
      return res.status(404).json({ error: `Table ${tableNum} does not exist.` });
    }
    // Mark table as occupied
    if (table.status !== 'occupied') {
      table.status = 'occupied';
      table.occupiedAt = new Date().toISOString();
      saveDB();
      // Broadcast table update
      broadcast({ type: 'TABLE_STATUS_CHANGED', data: table });
    }
    return res.json({
      success: true,
      user: {
        id: `customer_table_${tableNum}`,
        role: 'customer',
        name: `Table ${tableNum}`,
        tableNumber: tableNum,
        captainId: table.captainId
      }
    });
  }
  // Chef, Captain, Manager Authentication
  const user = db.users.find(u => u.username === username && u.role === role);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or role.' });
  }
  return res.json({ success: true, user });
});
// 2. Fetch Menu Items
app.get('/api/menu', (req, res) => {
  res.json(db.menuItems);
});
// 3. Get Requests (with filters)
app.get('/api/requests', (req, res) => {
  const { role, category, table } = req.query;
  let filteredRequests = [...db.requests];
  if (role === 'customer' && table) {
    filteredRequests = filteredRequests.filter(r => r.tableNumber === parseInt(table, 10));
  } else if (role === 'chef' && category) {
    // If chef has a category filter, show only requests matching that category
    filteredRequests = filteredRequests.filter(r => r.category.toLowerCase() === category.toLowerCase());
  }
  // Sort by timestamp desc
  filteredRequests.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(filteredRequests);
});
// 4. Submit Food Request (Customer)
app.post('/api/requests', (req, res) => {
  const { itemId, tableNumber, type } = req.body;
  
  if (!itemId || !tableNumber) {
    return res.status(400).json({ error: 'Item ID and Table Number are required.' });
  }
  const item = db.menuItems.find(i => i.id === itemId);
  if (!item) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }
  if (item.availability === 'out-of-stock') {
    return res.status(400).json({ error: 'This item is currently out of stock.' });
  }
  const tableNum = parseInt(tableNumber, 10);
  const table = db.tables.find(t => t.number === tableNum);
  // Auto occupy table just in case
  if (table && table.status !== 'occupied') {
    table.status = 'occupied';
    table.occupiedAt = new Date().toISOString();
    broadcast({ type: 'TABLE_STATUS_CHANGED', data: table });
  }
  const request = {
    id: generateId('req'),
    tableNumber: tableNum,
    itemId: item.id,
    itemName: item.name,
    category: item.category,
    type: type || 'fresh', // 'fresh' or 'refill'
    timestamp: new Date().toISOString(),
    status: 'sent',
    history: [
      { status: 'sent', timestamp: new Date().toISOString() }
    ],
    chefId: null,
    captainId: table ? table.captainId : null
  };
  db.requests.push(request);
  saveDB();
  // Broadcast creation to all connected clients
  broadcast({ type: 'REQUEST_CREATED', data: request });
  res.status(201).json(request);
});
// 5. Update Request Status / Menu Item (Chef or Captain or Manager)
app.patch('/api/requests/:id', (req, res) => {
  const { id } = req.params;
  const { status, chefId, captainId } = req.body;
  const request = db.requests.find(r => r.id === id);
  if (!request) {
    return res.status(404).json({ error: 'Request not found.' });
  }
  if (status) {
    request.status = status;
    request.history.push({
      status,
      timestamp: new Date().toISOString()
    });
    if (chefId) {
      request.chefId = chefId;
    }
    if (captainId) {
      request.captainId = captainId;
    }
    saveDB();
    // Broadcast the update
    broadcast({ type: 'REQUEST_UPDATED', data: request });
    
    // Create notifications for special stages
    if (status === 'completed') {
      const notification = {
        id: generateId('notif'),
        type: 'delivery_ready',
        message: `Food Ready For Delivery! Table ${request.tableNumber} - ${request.itemName}`,
        tableNumber: request.tableNumber,
        requestId: request.id,
        captainId: request.captainId,
        timestamp: new Date().toISOString()
      };
      db.notifications.push(notification);
      saveDB();
      broadcast({ type: 'NOTIFICATION', data: notification });
    }
    
    if (status === 'served') {
      const notification = {
        id: generateId('notif'),
        type: 'served_successfully',
        message: `Served Successfully: ${request.itemName} delivered to Table ${request.tableNumber}`,
        tableNumber: request.tableNumber,
        requestId: request.id,
        timestamp: new Date().toISOString()
      };
      db.notifications.push(notification);
      saveDB();
      broadcast({ type: 'NOTIFICATION', data: notification });
    }
  }
  res.json(request);
});
// 6. Update Menu Item Availability (Chef / Manager)
app.patch('/api/menu/:id', (req, res) => {
  const { id } = req.params;
  const { availability, name, category, calories, protein, carbohydrates, fat, ingredients, allergens, isVeg } = req.body;
  const item = db.menuItems.find(i => i.id === id);
  if (!item) {
    return res.status(404).json({ error: 'Menu item not found.' });
  }
  if (availability) {
    item.availability = availability;
  }
  if (name !== undefined) item.name = name;
  if (category !== undefined) item.category = category;
  if (calories !== undefined) item.calories = parseInt(calories, 10);
  if (protein !== undefined) item.protein = parseInt(protein, 10);
  if (carbohydrates !== undefined) item.carbohydrates = parseInt(carbohydrates, 10);
  if (fat !== undefined) item.fat = parseInt(fat, 10);
  if (ingredients !== undefined) item.ingredients = Array.isArray(ingredients) ? ingredients : ingredients.split(',').map(s => s.trim());
  if (allergens !== undefined) item.allergens = Array.isArray(allergens) ? allergens : allergens.split(',').map(s => s.trim());
  if (isVeg !== undefined) item.isVeg = !!isVeg;
  saveDB();
  broadcast({ type: 'MENU_ITEM_UPDATED', data: item });
  res.json(item);
});
// 7. Add Menu Item (Chef / Manager)
app.post('/api/menu', (req, res) => {
  const { name, category, calories, protein, carbohydrates, fat, ingredients, allergens, isVeg } = req.body;
  if (!name || !category) {
    return res.status(400).json({ error: 'Name and Category are required.' });
  }
  const newItem = {
    id: generateId('item'),
    name,
    category,
    image: '/images/default_food.jpg',
    calories: parseInt(calories, 10) || 0,
    protein: parseInt(protein, 10) || 0,
    carbohydrates: parseInt(carbohydrates, 10) || 0,
    fat: parseInt(fat, 10) || 0,
    ingredients: Array.isArray(ingredients) ? ingredients : (ingredients ? ingredients.split(',').map(s => s.trim()) : []),
    allergens: Array.isArray(allergens) ? allergens : (allergens ? allergens.split(',').map(s => s.trim()) : []),
    isVeg: !!isVeg,
    availability: 'available'
  };
  db.menuItems.push(newItem);
  saveDB();
  broadcast({ type: 'MENU_ITEM_CREATED', data: newItem });
  res.status(201).json(newItem);
});
// 8. Submit Feedback (Customer)
app.post('/api/feedback', (req, res) => {
  const { tableNumber, rating, comments } = req.body;
  if (!tableNumber || !rating) {
    return res.status(400).json({ error: 'Table Number and Rating are required.' });
  }
  const feedbackObj = {
    id: generateId('feed'),
    tableNumber: parseInt(tableNumber, 10),
    rating: parseInt(rating, 10),
    comments: comments || '',
    timestamp: new Date().toISOString()
  };
  db.feedback.push(feedbackObj);
  saveDB();
  broadcast({ type: 'FEEDBACK_SUBMITTED', data: feedbackObj });
  res.status(201).json(feedbackObj);
});
// 9. Reset / Release Table (Manager / Captain)
app.post('/api/tables/release', (req, res) => {
  const { tableNumber } = req.body;
  const table = db.tables.find(t => t.number === parseInt(tableNumber, 10));
  if (!table) {
    return res.status(404).json({ error: 'Table not found.' });
  }
  table.status = 'available';
  table.occupiedAt = null;
  saveDB();
  broadcast({ type: 'TABLE_STATUS_CHANGED', data: table });
  res.json({ success: true, table });
});
// 10. Analytics (Manager)
app.get('/api/analytics', (req, res) => {
  const totalTables = db.tables.length;
  const occupiedTables = db.tables.filter(t => t.status === 'occupied').length;
  const availableTables = totalTables - occupiedTables;
  const totalRequests = db.requests.length;
  const pendingRequests = db.requests.filter(r => ['sent', 'accepted', 'preparing', 'cooking', 'almost-done'].includes(r.status)).length;
  const completedRequests = db.requests.filter(r => r.status === 'completed').length;
  const servedRequests = db.requests.filter(r => r.status === 'served').length;
  // Active Customers: count unique tables occupied
  const activeCustomers = occupiedTables;
  // Helper to calculate average durations
  const calcAvgTime = (reqList, startStatus, endStatus) => {
    let count = 0;
    let sumMs = 0;
    reqList.forEach(r => {
      const startHist = r.history.find(h => h.status === startStatus);
      const endHist = r.history.find(h => h.status === endStatus);
      if (startHist && endHist) {
        count++;
        sumMs += (new Date(endHist.timestamp) - new Date(startHist.timestamp));
      }
    });
    return count > 0 ? (sumMs / count / 1000 / 60) : 0; // minutes
  };
  // Chef monitoring
  const chefStats = db.users.filter(u => u.role === 'chef').map(chef => {
    const chefRequests = db.requests.filter(r => r.chefId === chef.id || (r.chefId === null && r.category === chef.category));
    const pending = chefRequests.filter(r => r.status === 'sent' || r.status === 'accepted').length;
    const preparing = chefRequests.filter(r => r.status === 'preparing').length;
    const cooking = chefRequests.filter(r => r.status === 'cooking' || r.status === 'almost-done').length;
    const completed = chefRequests.filter(r => r.status === 'completed' || r.status === 'served').length;
    // Prep time: sent to completed
    const avgPrep = calcAvgTime(chefRequests.filter(r => ['completed', 'served'].includes(r.status)), 'sent', 'completed');
    return {
      id: chef.id,
      name: chef.name,
      category: chef.category,
      pending,
      preparing,
      cooking,
      completed,
      avgPrepTime: avgPrep.toFixed(1)
    };
  });
  // Captain monitoring
  const captainStats = db.users.filter(u => u.role === 'captain').map(cap => {
    const capRequests = db.requests.filter(r => r.captainId === cap.id);
    const served = capRequests.filter(r => r.status === 'served').length;
    const pendingDeliveries = capRequests.filter(r => r.status === 'completed').length;
    
    // Delivery time: completed to served
    const avgDeliv = calcAvgTime(capRequests.filter(r => r.status === 'served'), 'completed', 'served');
    return {
      id: cap.id,
      name: cap.name,
      assignedTables: cap.tables,
      servedItems: served,
      pendingDeliveries,
      avgDeliveryTime: avgDeliv.toFixed(1)
    };
  });
  // Menu Analytics
  // Count frequency of requests
  const reqCounts = {};
  db.requests.forEach(r => {
    reqCounts[r.itemId] = (reqCounts[r.itemId] || 0) + 1;
  });
  const sortedMenuItems = [...db.menuItems].map(item => ({
    ...item,
    requestCount: reqCounts[item.id] || 0
  }));
  const mostRequested = [...sortedMenuItems].sort((a, b) => b.requestCount - a.requestCount).slice(0, 5);
  const leastRequested = [...sortedMenuItems].filter(i => i.availability !== 'out-of-stock').sort((a, b) => a.requestCount - b.requestCount).slice(0, 5);
  const outOfStock = db.menuItems.filter(i => i.availability === 'out-of-stock').map(i => i.name);
  const runningLow = db.menuItems.filter(i => i.availability === 'running-low').map(i => i.name);
  // Recent feedback rating average
  const totalRating = db.feedback.reduce((sum, f) => sum + f.rating, 0);
  const avgRating = db.feedback.length > 0 ? (totalRating / db.feedback.length).toFixed(1) : '5.0';
  res.json({
    liveDashboard: {
      totalTables,
      occupiedTables,
      availableTables,
      activeCustomers,
      pendingRequests,
      completedRequests,
      servedRequests,
      avgRating
    },
    chefMonitoring: chefStats,
    captainMonitoring: captainStats,
    menuAnalytics: {
      mostRequested,
      leastRequested,
      outOfStock,
      runningLow
    }
  });
});
// Fallback to SPA index.html for undefined routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const MAX_PORT_TRIES = 5;

async function findAvailablePort(startPort, maxAttempts) {
  let port = startPort;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const available = await new Promise((resolve, reject) => {
      const tester = net.createServer()
        .once('error', (err) => {
          tester.close(() => {
            if (err.code === 'EADDRINUSE') {
              resolve(false);
            } else {
              reject(err);
            }
          });
        })
        .once('listening', () => {
          tester.close(() => resolve(true));
        })
        .listen(port);
    });
    if (available) {
      return port;
    }
    port += 1;
  }
  throw new Error(`No available ports found in range ${startPort}-${startPort + maxAttempts - 1}`);
}

const PORT = await findAvailablePort(DEFAULT_PORT, MAX_PORT_TRIES);

// Create Server
const server = createServer(app);

// WebSocket Server Setup
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`WebSocket client connected. Total clients: ${clients.size}`);
  ws.on('message', (message) => {
    try {
      const parsed = JSON.parse(message);
      // We can handle incoming web socket messages if needed (e.g. chat, live updates check)
      console.log('Received WebSocket message:', parsed);
    } catch (err) {
      console.error('Error parsing WS message:', err);
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    console.log(`WebSocket client disconnected. Total clients: ${clients.size}`);
  });
  // Send a connection confirmation
  ws.send(JSON.stringify({ type: 'CONNECTED', data: { message: 'Real-time sync established.' } }));
});

server.listen(PORT, () => {
  console.log(`FLECHAZO Buffet System is running on http://localhost:${PORT}`);
});
