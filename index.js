const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

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
    const database = client.db('digital_life_lessons_db');
    const lessonsCollection = database.collection('lessons');
    const favoritesCollection = database.collection('favorites');

    // --- ফেভারিট লিস্ট পাওয়ার রাউট (GET /favorites/:userId) ---
    app.get('/favorites/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const { category, emotionalTone } = req.query;

        // ১. ওই ইউজারের সব ফেভারিট রেকর্ড খুঁজে বের করা
        const userFavs = await favoritesCollection.find({ userId }).toArray();
        if (!userFavs.length) return res.json([]);

        // ২. লেসন আইডি গুলোর একটি অ্যারে তৈরি করা
        const lessonIds = userFavs.map(fav => new ObjectId(fav.lessonId));

        // ৩. ফিল্টারিং কোয়েরি তৈরি করা
        let filterQuery = { _id: { $in: lessonIds } };
        if (category) filterQuery.category = category;
        if (emotionalTone) filterQuery.emotionalTone = emotionalTone;

        // ৪. লেসন কালেকশন থেকে ডাটা নিয়ে আসা
        const savedLessons = await lessonsCollection
          .find(filterQuery)
          .toArray();

        // প্রতিটি লেসনের লাইক কাউন্টও পাঠানো
        const result = savedLessons.map(lesson => ({
          ...lesson,
          likesCount: lesson.likes?.length || 0,
        }));

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // --- আগের রাউটগুলো (সংক্ষেপে) ---
    app.post('/lessons', async (req, res) => {
      const lesson = req.body;
      const result = await lessonsCollection.insertOne({
        ...lesson,
        likes: [],
        likesCount: 0,
        favoritesCount: 0,
        createdAt: new Date(),
      });
      res.status(201).json(result);
    });

    app.get('/lessons', async (req, res) => {
      const lessons = await lessonsCollection
        .find({ visibility: 'Public' })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(lessons.map(l => ({ ...l, likesCount: l.likes?.length || 0 })));
    });

    app.post('/lessons/:id/like', async (req, res) => {
      const lessonId = req.params.id;
      const { userId } = req.body;
      const lesson = await lessonsCollection.findOne({
        _id: new ObjectId(lessonId),
      });
      const hasLiked = lesson.likes?.includes(userId);
      if (hasLiked) {
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $pull: { likes: userId }, $inc: { likesCount: -1 } },
        );
        res.json({ liked: false, message: 'Unliked' });
      } else {
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $addToSet: { likes: userId }, $inc: { likesCount: 1 } },
        );
        res.json({ liked: true, message: 'Liked' });
      }
    });

    app.post('/lessons/:id/favorite', async (req, res) => {
      const lessonId = req.params.id;
      const { userId } = req.body;
      const existingFav = await favoritesCollection.findOne({
        lessonId,
        userId,
      });
      if (existingFav) {
        await favoritesCollection.deleteOne({ lessonId, userId });
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: -1 } },
        );
        res.json({ favorited: false, message: 'Removed' });
      } else {
        await favoritesCollection.insertOne({
          lessonId,
          userId,
          savedAt: new Date(),
        });
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: 1 } },
        );
        res.json({ favorited: true, message: 'Saved' });
      }
    });

    console.log('Archive Ecosystem Online!');
  } catch (err) {
    console.error(err);
  }
}
run().catch(console.dir);
app.listen(PORT, () => console.log(`Running on ${PORT}`));
