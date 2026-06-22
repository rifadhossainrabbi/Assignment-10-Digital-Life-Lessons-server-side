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
    const usersCollection = database.collection('user');
    const lessonReportCollection = database.collection('lessons_reports');

    // Get lessons route (only public visibility)
    app.get('/lessons', async (req, res) => {
      const lessons = await lessonsCollection
        .find({ visibility: 'Public' })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(lessons.map(l => ({ ...l, likesCount: l.likes?.length || 0 })));
    });

    // --- Admin: Get ALL lessons (Public + Private) with Stats ---
    app.get('/admin/all-lessons', async (req, res) => {
      try {
        const lessons = await lessonsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();

        // Calculate Stats for Admin Dashboard
        const stats = {
          total: lessons.length,
          publicCount: lessons.filter(l => l.visibility === 'Public').length,
          privateCount: lessons.filter(l => l.visibility === 'Private').length,
          featuredCount: lessons.filter(l => l.isFeatured).length,
        };

        res.send({ lessons, stats });
      } catch (error) {
        res.status(500).send({ message: 'Error fetching lessons' });
      }
    });

    // --- Admin: Update Featured/Reviewed status ---
    app.patch('/admin/lessons/status/:id', async (req, res) => {
      const id = req.params.id;
      const updateData = req.body; // e.g., { isFeatured: true } or { isReviewed: true }
      const result = await lessonsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updateData },
      );
      res.send(result);
    });

    // --- Admin: Delete any lesson ---
    app.delete('/admin/lessons/:id', async (req, res) => {
      const id = req.params.id;
      const result = await lessonsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // Get lessons created by a specific user
    app.get('/lessons/user/:userId', async (req, res) => {
      try {
        const { userId } = req.params;
        const lessons = await lessonsCollection
          .find({ 'author.userId': userId })
          .sort({ createdAt: -1 })
          .toArray();

        res.json(lessons); // Directly sending the DB data
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // post lesson route
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

    // Get lesson details with Author stats and User interactions
    app.get('/lessons/:id', async (req, res) => {
      try {
        // params
        const { id } = req.params;
        // query
        const userId = req.query.userId;

        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!lesson)
          return res.status(404).json({ message: 'Lesson not found' });

        // author all lessons
        const authorId = lesson.author?.userId;
        const authorLessonsCount = await lessonsCollection.countDocuments({
          'author.userId': authorId,
        });

        // currnet user like lesson data hunting
        let hasLiked = false;
        let hasFavorited = false;

        if (userId) {
          hasLiked = lesson.likes?.includes(userId) || false;
          const fav = await favoritesCollection.findOne({
            lessonId: id,
            userId: userId,
          });
          hasFavorited = !!fav;
        }

        // lesson detail, author all lesson count, like count, favorites count sent
        res.json({
          ...lesson,
          author: {
            ...lesson.author,
            lessonsCount: authorLessonsCount,
          },
          hasLiked,
          hasFavorited,
          likesCount: lesson.likes?.length || 0,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // like count detail route
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
          // pull = array theke data delete, inc= increement data er count er update
          // https://www.mongodb.com/docs/manual/reference/mql/update/?utm_source=chatgpt.com
          { $pull: { likes: userId }, $inc: { likesCount: -1 } },
        );
        res.json({ liked: false, message: 'Unliked' });
      } else {
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          // addToSet = array te notun data add
          { $addToSet: { likes: userId }, $inc: { likesCount: 1 } },
        );
        res.json({ liked: true, message: 'Liked' });
      }
    });

    // favorites lesson detail by userId
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

    // favorites lesson detail route
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

    /**
     * Route: GET /admin/users
     * Fetching users and their total lessons count
     */
    app.get('/admin/users', async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();

        // Mapping each user to count their specific lessons from the lessons collection
        const usersWithStats = await Promise.all(
          users.map(async user => {
            const count = await lessonsCollection.countDocuments({
              'author.userId': user._id.toString(),
            });
            return {
              ...user,
              totalLessons: count,
            };
          }),
        );

        res.send(usersWithStats);
      } catch (error) {
        res
          .status(500)
          .send({ message: 'Error fetching users', error: error.message });
      }
    });

    /**
     * Route: PATCH /admin/users/role/:id
     * Update role from 'user' to 'admin'
     */
    app.patch('/admin/users/role/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updateDoc = { $set: { role: 'admin' } };
        const result = await usersCollection.updateOne(filter, updateDoc);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Failed to update role' });
      }
    });

    /**
     * Route: DELETE /admin/users/:id
     * Delete user account permanently
     */
    app.delete('/admin/users/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const result = await usersCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: 'Failed to delete user' });
      }
    });

    /**
     * Route: PATCH /admin/profile/update/:id
     * Purpose: Update Admin profile details (Name and Image)
     * Access: Admin only (typically verified via middleware/session)
     */
    app.patch('/admin/profile/update/:id', async (req, res) => {
      try {
        const id = req.params.id;
        const { name, image } = req.body; // Extract data from request body

        // Create filter using MongoDB ObjectId
        const filter = { _id: new ObjectId(id) };

        // Define the update operation
        const updateDoc = {
          $set: {
            name: name,
            image: image, // Updates both image and photoURL fields if needed
            photoURL: image,
          },
        };

        // Execute the update in the 'user' collection
        const result = await usersCollection.updateOne(filter, updateDoc);

        if (result.modifiedCount > 0) {
          res.status(200).send({
            success: true,
            message: 'Admin profile updated in the archive successfully',
            result,
          });
        } else {
          res.status(404).send({
            success: false,
            message: 'No changes made or user not found',
          });
        }
      } catch (error) {
        // Handle potential server or database errors
        res.status(500).send({
          success: false,
          message: 'Failed to update admin profile registry',
          error: error.message,
        });
      }
    });

    // --- REPORTING SYSTEM ---

    /**
     * Route: POST /lessons/:id/report
     * Purpose: Allows logged-in users to flag inappropriate content
     */
    app.post('/lessons/:id/report', async (req, res) => {
      try {
        const lessonId = req.params.id;
        const { userId, userEmail, reason, additionalDetails, lessonTitle } =
          req.body;

        const reportEntry = {
          lessonId,
          lessonTitle,
          reporterUserId: userId,
          reportedUserEmail: userEmail,
          reason,
          additionalDetails, // Storing the textarea content
          timestamp: new Date(),
        };

        const result = await lessonReportCollection.insertOne(reportEntry);
        res.status(201).send({ success: true, result });
      } catch (error) {
        res.status(500).send({ message: 'Error' });
      }
    });

    /**
     * Route: GET /admin/reported-lessons
     * Purpose: Aggregates reports so admin sees unique lessons and their report counts
     */
    app.get('/admin/reported-lessons', async (req, res) => {
      try {
        // Grouping by lessonId to show a summary in the admin table
        const reportedLessons = await lessonReportCollection
          .aggregate([
            {
              $group: {
                _id: '$lessonId',
                lessonTitle: { $first: '$lessonTitle' },
                reportCount: { $sum: 1 },
                allReports: { $push: '$$ROOT' }, // Keep details for the admin modal
              },
            },
            { $sort: { reportCount: -1 } },
          ])
          .toArray();

        res.send(reportedLessons);
      } catch (error) {
        res.status(500).send({ message: 'Error fetching reported content' });
      }
    });

    /**
     * Route: DELETE /admin/reports/ignore/:lessonId
     * Purpose: Clears all reports for a specific lesson without deleting the lesson
     */
    app.delete('/admin/reports/ignore/:lessonId', async (req, res) => {
      try {
        const { lessonId } = req.params;
        const result = await lessonReportCollection.deleteMany({ lessonId });
        res.send({ success: true, message: 'Reports cleared', result });
      } catch (error) {
        res.status(500).send({ message: 'Action failed' });
      }
    });

    /**
     * Route: DELETE /admin/lessons/:id (Modified)
     * Purpose: Deletes a lesson and also cleans up its associated reports
     */
    app.delete('/admin/lessons/:id', async (req, res) => {
      const id = req.params.id;
      // 1. Delete the lesson itself
      const lessonResult = await lessonsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      // 2. Clean up associated reports from the reports collection
      await lessonReportCollection.deleteMany({ lessonId: id });

      res.send(lessonResult);
    });

    console.log('Archive Ecosystem Online!');
  } catch (err) {
    console.error(err);
  }
}
run().catch(console.dir);
app.listen(PORT, () => console.log(`Running on ${PORT}`));
