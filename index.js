const express = require('express');
const cors = require('cors');
const app = express();
const port = 5000;
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

// Middleware
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Digital Life Lessons Server is Running!');
});

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect();

    const database = client.db('digital_life_lessons_db');
    const lessonsCollection = database.collection('lessons');

    // 📥 POST Lesson Endpoint
    app.post('/lessons', async (req, res) => {
      try {
        const lesson = req.body;
        const result = await lessonsCollection.insertOne(lesson);
        res.status(201).send(result);
      } catch (error) {
        console.error('Error inserting lesson:', error);
        res.status(500).send({ message: 'Failed to save lesson data.' });
      }
    });

    // 📤 GET All Lessons Endpoint (Added for retrieving data)
    app.get('/lessons', async (req, res) => {
      try {
        // Fetch only public visibility lessons from database
        const query = { visibility: 'Public' };
        const cursor = lessonsCollection.find(query);
        const result = await cursor.toArray();
        res.status(200).send(result);
      } catch (error) {
        console.error('Error fetching lessons:', error);
        res.status(500).send({ message: 'Failed to fetch lesson matrices.' });
      }
    });

    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 });
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!',
    );
  } catch (err) {
    console.error('MongoDB Connection Error: ', err);
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Server app listening on port ${port}`);
});
