require('dotenv').config(); // ✅ Load environment variables from .env
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

// ✅ Initialize Express & Server
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ✅ Middleware
app.use(cors());
app.use(express.json({ limit: '1024mb' }));

// ✅ MongoDB Connection using environment variable
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ Error connecting to MongoDB:', err.message);
    process.exit(1);
  });

// Ensure directories exist
const directories = [
    process.env.LOCAL_DATA_PATH,
    process.env.CHANGE_DATA_PATH,
    process.env.SAVE_FOLDER,
    process.env.LOG_PATH
];

directories.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
});

const logDatabaseAction = (collectionName, action, documentId = null, details = {}) => {
  const logData = {
    timestamp: new Date().toISOString(),
    collectionName,
    action,
    documentId,
    details
  };

  // Log to console for now (you can replace this with writing to a file or database)
  console.log('Database Action:', JSON.stringify(logData, null, 2));

  // If you want to log to a file, you could do something like this:
  const logFilePath = path.join(SAVE_FOLDER, 'database-actions.log');
  fs.appendFileSync(logFilePath, JSON.stringify(logData) + '\n');
};


const saveCollectionDataToFile = (collectionName, data, folderPath) => {
  const filePath = path.join(folderPath, `${collectionName}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`✅ Collection "${collectionName}" data saved.`);
};

// ✅ WebSocket Events
io.on('connection', (socket) => {
  console.log('✅ WebSocket Client Connected');
  socket.on('disconnect', () => console.log('❌ WebSocket Client Disconnected'));
});

// =========================
// ✅ API Routes
// =========================
// ✅ Fetch Logs API (for Frontend to get logs)
app.get('/fetch-logs/:collectionName', async (req, res) => {
  const { collectionName } = req.params;
  const { selectedDate } = req.query;

  try {
    const collection = mongoose.connection.collection(collectionName);
    let query = {};

    if (selectedDate) {
      if (collectionName === 'purchaseorders') {
        query = { PODate: { $gte: new Date(`${selectedDate}T00:00:00`), $lt: new Date(`${selectedDate}T23:59:59`) } };
      } else {
        query = { created: { $gte: new Date(`${selectedDate}T00:00:00`), $lt: new Date(`${selectedDate}T23:59:59`) } };
      }
    }

    const documents = await collection.find(query).toArray();
    logDatabaseAction(collectionName, 'fetchLogs', null, { fetchedLogsCount: documents.length });
    res.json(documents);
  } catch (err) {
    console.error(`Error Fetching Logs for "${collectionName}":`, err.message);
    res.status(500).json({ message: 'Error fetching logs.', error: err.message });
  }
});

// ✅ Dashboard Metrics API
app.get('/dashboard-metrics/:collectionName', async (req, res) => {
  const { collectionName } = req.params;
  try {
    const collection = mongoose.connection.collection(collectionName);
    const pipeline = [
      {
        $group: {
          _id: '$createdBy',
          totalSales: { $sum: { $ifNull: ['$sales', 0] } }
        }
      },
      { $sort: { totalSales: -1 } },
      { $limit: 5 }
    ];
    const topUsers = await collection.aggregate(pipeline).toArray();

    const totalRecords = await collection.countDocuments();
    res.json({ totalRecords, topUsers });
  } catch (err) {
    console.error(`❌ Error Fetching Metrics for "${collectionName}":`, err.message);
    res.status(500).json({ message: 'Error fetching metrics.', error: err.message });
  }
});

// ✅ Real-Time Data Updates
setInterval(async () => {
  const collections = await mongoose.connection.db.listCollections().toArray();
  collections.forEach(async (col) => {
    const data = await mongoose.connection.collection(col.name).find().limit(10).toArray();
    io.emit('realTimeData', { collection: col.name, data });
  });
}, 30000); // Every 30 seconds

// ✅ Collection Operations
app.get('/fetch-collection/:collectionName', async (req, res) => {
  const { collectionName } = req.params;
  try {
    const collection = mongoose.connection.collection(collectionName);
    const documents = await collection.find().toArray();
    saveCollectionDataToFile(collectionName, documents, LOCAL_DATA_PATH);
    logDatabaseAction(collectionName, 'fetch', null, { fetchedCount: documents.length });
    res.json({ message: `Fetched ${documents.length} documents.`, data: documents });
  } catch (err) {
    console.error(`❌ Error Fetching Collection "${collectionName}":`, err.message);
    res.status(500).json({ message: 'Error fetching collection.', error: err.message });
  }
});

// ✅ Insert Document
app.post('/insert-document/:collectionName', async (req, res) => {
  const { collectionName } = req.params;
  const newDocument = req.body;

  try {
    const collection = mongoose.connection.collection(collectionName);
    const result = await collection.insertOne(newDocument);
    logDatabaseAction(collectionName, 'insert', result.insertedId, newDocument);
    res.status(201).json({ message: 'Document inserted.', documentId: result.insertedId });
  } catch (err) {
    console.error(`❌ Insert Error:`, err.message);
    res.status(500).json({ message: 'Insert failed.', error: err.message });
  }
});

// ✅ Update Document
app.put('/update-document/:collectionName/:id', async (req, res) => {
  const { collectionName, id } = req.params;
  const updatedData = req.body;

  try {
    const collection = mongoose.connection.collection(collectionName);
    const result = await collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: updatedData });

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: 'Document not found.' });
    }

    logDatabaseAction(collectionName, 'update', id, updatedData);
    res.json({ message: 'Document updated successfully.' });
  } catch (err) {
    console.error(`❌ Update Error:`, err.message);
    res.status(500).json({ message: 'Update failed.', error: err.message });
  }
});

// ✅ Delete Document
app.delete('/delete-document/:collectionName/:id', async (req, res) => {
  const { collectionName, id } = req.params;

  try {
    const collection = mongoose.connection.collection(collectionName);
    const result = await collection.deleteOne({ _id: new mongoose.Types.ObjectId(id) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: 'Document not found.' });
    }

    logDatabaseAction(collectionName, 'delete', id);
    res.json({ message: 'Document deleted successfully.' });
  } catch (err) {
    console.error(`❌ Delete Error:`, err.message);
    res.status(500).json({ message: 'Delete failed.', error: err.message });
  }
});

// ✅ Get Local Data
app.get('/get-local-data/:collectionName', (req, res) => {
  const { collectionName } = req.params;
  const filePath = path.join(LOCAL_DATA_PATH, `${collectionName}.json`);

  if (fs.existsSync(filePath)) {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        console.error(`❌ Error reading local data:`, err.message);
        return res.status(500).json({ message: 'Error reading local data.' });
      }
      return res.status(200).json(JSON.parse(data));
    });
  } else {
    res.status(404).json({ message: 'Local data not found.' });
  }
});

// ✅ Save Filtered Data
app.post('/save-filter-data/:collectionName', (req, res) => {
  const { collectionName } = req.params;
  const { filteredData, selectedFields, nestedSelectedFields } = req.body;

  try {
    const filePath = path.join(CHANGE_DATA_PATH, `${collectionName}Filtered.json`);
    fs.writeFileSync(filePath, JSON.stringify({ filteredData, selectedFields, nestedSelectedFields }, null, 2));
    console.log(`✅ Filtered data saved for collection: ${collectionName}`);
    res.json({ message: 'Filtered data saved successfully.' });
  } catch (err) {
    console.error('❌ Error saving filtered data:', err.message);
    res.status(500).json({ message: 'Error saving filtered data.' });
  }
});
// ✅ Save filter selections
app.post('/save-filter-selections/:collectionName', (req, res) => {
  const collectionName = req.params.collectionName;
  const filterData = req.body;

  // Save filter selections to file
  const filePath = path.join(SAVE_FOLDER, `${collectionName}-filter-selections.json`);
  fs.writeFile(filePath, JSON.stringify(filterData, null, 2), (err) => {
    if (err) {
      console.error('Error saving filter selections:', err);
      res.status(500).json({ message: 'Error saving filter selections.' });
    } else {
      console.log(`Filter selections saved successfully for ${collectionName}.`);
      res.status(200).json({ message: 'Filter selections saved successfully.' });
    }
  });
});

// ✅ Load Filter Selections
app.get('/load-filter-selections/:collectionName', (req, res) => {
  const { collectionName } = req.params;
  const filePath = path.join(SAVE_FOLDER, `${collectionName}-filter-selections.json`);

  if (fs.existsSync(filePath)) {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        console.error('❌ Error reading filter selections:', err.message);
        return res.status(500).send('Error reading filter selections.');
      }
      res.status(200).json(JSON.parse(data));
    });
  } else {
    res.status(404).json({ message: 'No filter selections found.' });
  }
});

// ✅ Save Dark Mode Setting
app.post('/save-dark-mode', (req, res) => {
  const { isDarkMode } = req.body;
  const filePath = path.join(SAVE_FOLDER, 'dark-mode.json');

  fs.writeFile(filePath, JSON.stringify({ isDarkMode }), (err) => {
    if (err) {
      console.error('❌ Error saving dark mode setting:', err);
      return res.status(500).json({ message: 'Error saving dark mode setting.' });
    }
    res.status(200).json({ message: 'Dark mode setting saved.' });
  });
});

// ✅ Load Dark Mode Setting
app.get('/load-dark-mode', (req, res) => {
  const filePath = path.join(SAVE_FOLDER, 'dark-mode.json');

  if (fs.existsSync(filePath)) {
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        console.error('❌ Error reading dark mode setting:', err);
        return res.status(500).json({ message: 'Error loading dark mode setting.' });
      }
      res.status(200).json(JSON.parse(data));
    });
  } else {
    res.status(200).json({ isDarkMode: false }); // Default to light mode
  }
});

// ✅ Alerts API
app.post('/set-alert', (req, res) => {
  const { collection, condition, message } = req.body;
  io.emit('alert', { collection, condition, message });
  res.json({ message: 'Alert set successfully.' });
});

// =========================
// ✅ Start Server
// =========================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
