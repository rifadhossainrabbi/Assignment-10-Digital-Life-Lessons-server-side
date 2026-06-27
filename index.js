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
    const commentsCollection = database.collection('comments');
    const sessionCollection = database.collection('session');

    const verifyToken = async (req, res, next) => {
      const authHeader = req.headers?.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: 'Unauthorized access' });
      }

      const token = authHeader.split(' ')[1];
      console.log('token', token);
      if (!token) {
        return res.status(401).send({ message: 'Unauthorized access' });
      }

      const query = { token: token };
      const session = await sessionCollection.findOne(query);
      if (!session) {
        return res
          .status(401)
          .send({ message: 'Unauthorized access: Invalid session' });
      }
      const userId = session.userId;

      const userQuery = { _id: userId };
      const user = await usersCollection.findOne(userQuery);
      console.log('user of the session', user);

      // set data in the req object
      req.user = user;
      next();
    };

    // must be used after verifyToken
    const verifyUser = async (req, res, next) => {
      if (req.user?.role !== 'user') {
        return res.status(403).send({ message: 'Forbidden access' });
      }
      next();
    };

    const verifyAnyUser = async (req, res, next) => {
      if (!req.user) return res.status(401).send({ message: 'Unauthorized' });
      next();
    };

    const verifyAdmin = async (req, res, next) => {
      if (req.user?.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden access' });
      }
      next();
    };

    //Get lessons with Search, Filter & Pagination
    app.get('/lessons', async (req, res) => {
      try {
        const {
          search,
          category,
          emotionalTone,
          page = 1,
          limit = 8,
        } = req.query;

        // only public lesson send
        let query = { visibility: 'Public' };

        // search filter
        if (search) {
          query.$or = [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ];
        }

        // category filter
        if (category && category !== 'All') {
          query.category = category;
        }

        // emotional tone filter
        if (emotionalTone && emotionalTone !== 'All') {
          query.emotionalTone = emotionalTone;
        }

        // pagination
        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        // all lesson
        const totalLessons = await lessonsCollection.countDocuments(query);
        const lessons = await lessonsCollection
          .find(query)
          .sort({ createdAt: -1 }) // সবসময় লেটেস্ট আগে
          .skip(skip)
          .limit(limitNumber)
          .toArray();

        // send result
        res.send({
          lessons: lessons.map(l => ({
            ...l,
            likesCount: l.likes?.length || 0,
          })),
          totalLessons,
          totalPages: Math.ceil(totalLessons / limitNumber),
          currentPage: pageNumber,
        });
      } catch (error) {
        res.status(500).send({ message: 'Error fetching lessons' });
      }
    });

    // --- Admin: Get ALL lessons (Public + Private) with Reports + Stats ---
    app.get(
      '/admin/all-lessons',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const lessons = await lessonsCollection
            .find()
            .sort({ createdAt: -1 })
            .toArray();

          // all report
          const reports = await lessonReportCollection.find().toArray();

          // lessonId report group
          const reportMap = {};

          reports.forEach(report => {
            if (!reportMap[report.lessonId]) {
              reportMap[report.lessonId] = [];
            }
            reportMap[report.lessonId].push(report);
          });

          // lesson er sathe report o add kora hoyase
          const lessonsWithReports = lessons.map(lesson => ({
            ...lesson,
            reports: reportMap[lesson._id.toString()] || [],
          }));

          // Unique flagged lesson count
          const flaggedCount = Object.keys(reportMap).length;

          const stats = {
            total: lessons.length,
            publicCount: lessons.filter(l => l.visibility === 'Public').length,
            privateCount: lessons.filter(l => l.visibility === 'Private')
              .length,
            featuredCount: lessons.filter(l => l.isFeatured).length,
            flaggedCount,
          };

          res.send({
            lessons: lessonsWithReports,
            stats,
          });
        } catch (error) {
          console.error(error);
          res.status(500).send({
            message: 'Error fetching lessons',
          });
        }
      },
    );

    // --- Admin: Update Featured/Reviewed status ---
    app.patch(
      '/admin/lessons/status/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const updateData = req.body; // e.g., { isFeatured: true } or { isReviewed: true }
        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData },
        );
        res.send(result);
      },
    );

    // --- Admin: Delete any lesson ---
    app.delete(
      '/admin/lessons/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          if (!ObjectId.isValid(id))
            return res.status(400).send('Invalid Lesson ID');

          // 1. Mul lesson delete kora hocche
          const lessonResult = await lessonsCollection.deleteOne({
            _id: new ObjectId(id),
          });

          // 2. Oi lesson er joto report 'lessons_reports' collection a ase sob clean kora hocche
          const reportsResult = await lessonReportCollection.deleteMany({
            lessonId: id, // lessonId eikhane string hisebe thake
          });

          // 3. Oi lesson jodi keu favorite kore thake, ta 'favorites' theke muche fela hocche
          const favoritesResult = await favoritesCollection.deleteMany({
            lessonId: id,
          });

          // 4. Oi lesson er joto comments 'comments' collection a ase sob purge kora hocche
          const commentsResult = await commentsCollection.deleteMany({
            lessonId: id,
          });

          // Sob result ekta object a kore pathano hocche jeno trace kora jay
          res.send({
            success: true,
            message: 'Complete data purge successful! No orphans left.',
            stats: {
              lessonDeleted: lessonResult.deletedCount,
              reportsCleared: reportsResult.deletedCount,
              favoritesRemoved: favoritesResult.deletedCount,
              commentsRemoved: commentsResult.deletedCount,
            },
          });
        } catch (error) {
          console.error('Purge Error:', error);
          res.status(500).send({ message: 'Complete purge sequence failed' });
        }
      },
    );

    // Get lessons created by a specific user
    app.get(
      '/lessons/user/:userId',
      verifyToken,
      verifyUser,
      async (req, res) => {
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
      },
    );

    // post lesson route
    app.post('/lessons', verifyToken, async (req, res) => {
      const lesson = req.body;
      const userId = lesson.author?.userId;

      // check user plan
      const user = await usersCollection.findOne({ _id: new ObjectId(userId) });

      // plan free hole koyta lesson ase ta dekhbe
      if (user?.plan === 'free') {
        const count = await lessonsCollection.countDocuments({
          'author.userId': userId,
        });
        if (count >= 5) {
          return res.status(403).json({
            message:
              'Free limit reached! Upgrade to Premium for unlimited publishing.',
          });
        }
        lesson.accessLevel = 'Free';
      }

      const result = await lessonsCollection.insertOne({
        ...lesson,
        likes: [],
        likesCount: 0,
        favoritesCount: 0,
        createdAt: new Date(),
      });
      res.status(201).json(result);
    });

    app.patch('/lessons/:id', verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const user = req.user;

        // find lesson
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!lesson)
          return res.status(404).send({ message: 'Lesson not found' });

        // owner secure
        if (
          lesson.author?.userId !== user._id.toString() &&
          user.role !== 'admin'
        ) {
          return res
            .status(403)
            .send({ message: 'You cannot edit this lesson' });
        }
        const {
          visibility,
          accessLevel,
          title,
          description,
          category,
          emotionalTone,
          updatedAt,
          image,
        } = req.body;

        const updateDoc = {};
        if (visibility) updateDoc.visibility = visibility;
        if (accessLevel) updateDoc.accessLevel = accessLevel;
        if (title) updateDoc.title = title;
        if (description) updateDoc.description = description;
        if (category) updateDoc.category = category;
        if (emotionalTone) updateDoc.emotionalTone = emotionalTone;
        if (image) updateDoc.image = image;
        if (updatedAt) updateDoc.updatedAt = new Date(updatedAt);

        const result = await lessonsCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateDoc },
        );

        res.status(200).send(result);
      } catch (error) {
        res.status(500).send({ message: 'Update synchronization failed' });
      }
    });

    // --- User/Admin: Delete lesson with ownership check ---
    app.delete('/lessons/:id', verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const user = req.user;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: 'Invalid ID' });
        }

        // find lesson
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!lesson) {
          return res.status(404).send({ message: 'Lesson not found!' });
        }

        //  owner and admin check
        const isOwner = lesson.author?.userId === user._id.toString();
        const isAdmin = user.role === 'admin';

        if (!isOwner && !isAdmin) {
          // owner and admin na hole
          return res.status(403).send({
            success: false,
            message: 'Forbidden: You can only delete your own lessons.',
          });
        }

        await lessonsCollection.deleteOne({ _id: new ObjectId(id) });

        // same lesosn er sob collection theke data delete
        await lessonReportCollection.deleteMany({ lessonId: id });
        await favoritesCollection.deleteMany({ lessonId: id });
        await commentsCollection.deleteMany({ lessonId: id });

        res.send({
          success: true,
          message: isAdmin
            ? 'Admin deleted the lesson and its metadata.'
            : 'Your lesson has been deleted successfully.',
        });
      } catch (error) {
        console.error('Delete Error:', error);
        res
          .status(500)
          .send({ message: 'Internal server error during deletion' });
      }
    });

    // like count detail route
    app.post('/lessons/:id/like', verifyToken, async (req, res) => {
      const lessonId = req.params.id;
      const userId = req.user._id.toString();
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
    app.get('/favorites/:userId', verifyToken, async (req, res) => {
      try {
        const { userId } = req.params;
        const authenticatedUserId = req.user._id.toString();

        // owner check
        if (userId !== authenticatedUserId) {
          return res.status(403).json({
            success: false,
            message:
              "Forbidden: You cannot access someone else's favorite list.",
          });
        }

        const { category, emotionalTone } = req.query;

        // find favorite lesson by userId
        const userFavs = await favoritesCollection.find({ userId }).toArray();
        if (!userFavs.length) return res.json([]);

        const lessonIds = userFavs.map(fav => new ObjectId(fav.lessonId));

        // filter
        let filterQuery = { _id: { $in: lessonIds } };
        if (category) filterQuery.category = category;
        if (emotionalTone) filterQuery.emotionalTone = emotionalTone;

        // lesson collection theke data find
        const savedLessons = await lessonsCollection
          .find(filterQuery)
          .toArray();

        // likeCounts add
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
    app.post('/lessons/:id/favorite', verifyToken, async (req, res) => {
      const lessonId = req.params.id;
      const userId = req.user._id.toString();

      // age theke favourite kora ase ki na
      const existingFav = await favoritesCollection.findOne({
        lessonId,
        userId,
      });

      if (existingFav) {
        // যদি আগে থেকে থাকে, তবে ডিলিট (Unfavorite)
        await favoritesCollection.deleteOne({ lessonId, userId });
        await lessonsCollection.updateOne(
          { _id: new ObjectId(lessonId) },
          { $inc: { favoritesCount: -1 } },
        );
        res.json({ favorited: false, message: 'Removed' });
      } else {
        // যদি না থাকে, তবে নতুন এন্ট্রি (Favorite)
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
    app.get('/admin/users', verifyToken, verifyAdmin, async (req, res) => {
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
    app.patch(
      '/admin/users/role/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const filter = { _id: new ObjectId(id) };
          const updateDoc = { $set: { role: 'admin' } };
          const result = await usersCollection.updateOne(filter, updateDoc);
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: 'Failed to update role' });
        }
      },
    );

    /**
     * Route: DELETE /admin/users/:id
     * Delete user account permanently
     */
    app.delete(
      '/admin/users/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const result = await usersCollection.deleteOne({
            _id: new ObjectId(id),
          });
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: 'Failed to delete user' });
        }
      },
    );

    /**
     * Route: PATCH /admin/profile/update/:id
     * Purpose: Update Admin profile details (Name and Image)
     */
    app.patch(
      '/admin/profile/update/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
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
      },
    );

    // --- REPORTING SYSTEM ---

    /**
     * Route: POST /lessons/:id/report
     * Purpose: Allows logged-in users to flag inappropriate content
     */
    app.post('/lessons/:id/report', verifyToken, async (req, res) => {
      try {
        const lessonId = req.params.id;
        const { reason, additionalDetails, lessonTitle } = req.body;

        const reportEntry = {
          lessonId,
          lessonTitle,
          reporterUserId: req.user._id.toString(), // from token
          reporterName: req.user.name, // from token
          reporterEmail: req.user.email, // from token
          reason,
          additionalDetails,
          timestamp: new Date(),
        };

        const result = await lessonReportCollection.insertOne(reportEntry);
        res.status(201).send({ success: true, result });
      } catch (error) {
        res.status(500).send({ message: 'Error reporting content' });
      }
    });

    /**
     * Route: GET /admin/reported-lessons
     * Improved with $lookup to fetch lesson image and reporter info
     */
    app.get(
      '/admin/reported-lessons',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await lessonReportCollection
            .aggregate([
              {
                $group: {
                  _id: '$lessonId',
                  lessonTitle: { $first: '$lessonTitle' },
                  reportCount: { $sum: 1 },
                  lastReportedAt: { $max: '$timestamp' },
                  allReports: { $push: '$$ROOT' },
                },
              },
              // ১. Lessons collection theke Image anar jonno lookup
              {
                $lookup: {
                  from: 'lessons',
                  let: { lId: '$_id' },
                  pipeline: [
                    {
                      $match: {
                        $expr: { $eq: [{ $toString: '$_id' }, '$$lId'] },
                      },
                    },
                    { $project: { image: 1 } },
                  ],
                  as: 'lessonData',
                },
              },
              // ২. Reporter er info anar jonno Reports unwind kore Users join kora
              { $unwind: '$allReports' },
              {
                $lookup: {
                  from: 'user',
                  let: { uId: '$allReports.reporterUserId' },
                  pipeline: [
                    {
                      $match: {
                        $expr: { $eq: [{ $toString: '$_id' }, '$$uId'] },
                      },
                    },
                    { $project: { name: 1, email: 1, image: 1 } },
                  ],
                  as: 'reporterDetails',
                },
              },
              {
                $addFields: {
                  'allReports.reporterInfo': {
                    $arrayElemAt: ['$reporterDetails', 0],
                  },
                },
              },
              // ৩. Sob gulo abar group kora original lessonId base-e
              {
                $group: {
                  _id: '$_id',
                  lessonTitle: { $first: '$lessonTitle' },
                  reportCount: { $first: '$reportCount' },
                  lastReportedAt: { $first: '$lastReportedAt' },
                  lessonImage: {
                    $first: { $arrayElemAt: ['$lessonData.image', 0] },
                  },
                  allReports: { $push: '$allReports' },
                },
              },
              { $sort: { lastReportedAt: -1 } },
            ])
            .toArray();

          res.send(result);
        } catch (err) {
          console.error(err);
          res.status(500).send('Admin data fetch error');
        }
      },
    );

    /**
     * Route: DELETE /admin/reports/ignore/:lessonId
     * Purpose: Clears all reports for a specific lesson without deleting the lesson
     */
    app.delete(
      '/admin/reports/ignore/:lessonId',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { lessonId } = req.params;
          const result = await lessonReportCollection.deleteMany({ lessonId });
          res.send({ success: true, message: 'Reports cleared', result });
        } catch (error) {
          res.status(500).send({ message: 'Action failed' });
        }
      },
    );

    /**
     * Route: DELETE /admin/lessons/:id (Modified)
     * Purpose: Deletes a lesson and also cleans up its associated reports
     */
    app.delete(
      '/admin/lessons/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;

          // 1. Delete lesson from main collection
          const lessonResult = await lessonsCollection.deleteOne({
            _id: new ObjectId(id),
          });

          // 2. Clean up associated flags/reports
          const reportsResult = await lessonReportCollection.deleteMany({
            lessonId: id,
          });

          // 3. Clean up user favorites (Requirement 2: No orphans)
          const favoritesResult = await favoritesCollection.deleteMany({
            lessonId: id,
          });

          // 4. Clean up lesson comments (Requirement 2: No orphans)
          const commentsResult = await commentsCollection.deleteMany({
            lessonId: id,
          });

          res.send({
            success: true,
            message: 'Complete purge successful',
            stats: {
              lessonDeleted: lessonResult.deletedCount,
              reportsCleared: reportsResult.deletedCount,
              favoritesRemoved: favoritesResult.deletedCount,
              commentsRemoved: commentsResult.deletedCount,
            },
          });
        } catch (error) {
          res.status(500).send({ message: 'Complete purge sequence failed' });
        }
      },
    );

    // --- Get Featured Lessons for Home Page (Strictly Featured only) ---
    app.get('/featured-lessons', async (req, res) => {
      try {
        // sudhu public r isFeatured true ase jei gulo oi data dibe
        const query = {
          isFeatured: true,
          visibility: 'Public',
        };

        const featuredLessons = await lessonsCollection
          .find(query)
          .sort({ createdAt: -1 }) // latest gulo age
          .limit(4) // shudhu 4 ta data pabe
          .toArray();

        res.send(featuredLessons);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    /**
     * Route: PATCH /users/plan-update route by user email
     */
    app.patch(
      '/users/plan-update',
      verifyToken,
      async (req, res) => {
        try {
          const { email } = req.body;
          console.log(email, "customer email")
          if (!email)
            return res.status(400).send({ message: 'Email is required' });

          const result = await usersCollection.updateOne(
            { email: email },
            { $set: { plan: 'premium' } },
          );

          if (result.modifiedCount > 0) {
            res.send({ success: true, message: 'Plan upgraded to premium' });
          } else {
            res.status(404).send({
              success: false,
              message: 'User not found or already premium',
            });
          }
        } catch (error) {
          res
            .status(500)
            .send({ message: 'Upgrade failed', error: error.message });
        }
      },
    );

    // 1. Route: POST /lessons/:id/comments
    // Purpose: Save a new comment/reflection for a specific lesson
    app.post('/lessons/:id/comments', verifyToken, async (req, res) => {
      try {
        const lessonId = req.params.id;
        const { text } = req.body;

        // name and id get from token
        const newComment = {
          lessonId,
          userId: req.user._id.toString(),
          userName: req.user.name,
          userImage: req.user.image,
          text: text,
          createdAt: new Date(),
        };

        const result = await commentsCollection.insertOne(newComment);
        res.status(201).json({ _id: result.insertedId, ...newComment });
      } catch (error) {
        res.status(500).json({ message: 'Failed to save comment' });
      }
    });

    // 2. Modify existing GET /lessons/:id to include comments
    app.get('/lessons/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const userId = req.user._id.toString();

        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!lesson)
          return res.status(404).json({ message: 'Lesson not found' });

        // --- Private visibility check ---
        const isOwner = lesson.author?.userId === req.user._id.toString();
        const isAdmin = req.user.role === 'admin';

        if (lesson.visibility === 'Private' && !isOwner && !isAdmin) {
          return res.status(403).json({ message: 'This is a private lesson.' });
        }

        // --- FETCH COMMENTS FOR THIS LESSON ---
        const comments = await commentsCollection
          .find({ lessonId: id })
          .sort({ createdAt: -1 }) // Show newest comments first
          .toArray();

        const authorId = lesson.author?.userId;
        const authorLessonsCount = await lessonsCollection.countDocuments({
          'author.userId': authorId,
        });

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

        // Include comments in the response object
        res.json({
          ...lesson,
          comments, // Sending comments array to frontend
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

    // Get Top 4 Contributors
    app.get('/top-contributors', async (req, res) => {
      try {
        const topUsers = await lessonsCollection
          .aggregate([
            {
              $match: {
                'author.userId': { $exists: true, $ne: null, $ne: '' },
              },
            },
            { $sort: { favoritesCount: -1, createdAt: -1 } },
            {
              $group: {
                _id: '$author.userId',
                name: { $first: '$author.name' },
                image: { $first: '$author.image' },
                totalLessons: { $sum: 1 },
                topLessonId: { $first: '$_id' },
                topLessonTitle: { $first: '$title' },
              },
            },
            { $sort: { totalLessons: -1 } },
            { $limit: 4 },
          ])
          .toArray();

        res.send(topUsers);
      } catch (error) {
        console.error('Aggregation Error:', error);
        res.status(500).send({ message: 'Failed to fetch contributors' });
      }
    });

    // --- Backend: Get Most Saved Lessons with check for current user ---
    app.get('/most-saved-lessons', async (req, res) => {
      const userId = req.query.userId;
      const topLessons = await lessonsCollection
        .find({ visibility: 'Public' })
        .sort({ favoritesCount: -1 })
        .limit(4)
        .toArray();

      if (userId) {
        const userFavs = await favoritesCollection.find({ userId }).toArray();
        const favIds = userFavs.map(f => f.lessonId);

        const result = topLessons.map(lesson => ({
          ...lesson,
          hasFavorited: favIds.includes(lesson._id.toString()),
        }));
        return res.send(result);
      }

      res.send(topLessons);
    });

    // Get Similar Lessons by category or emotional tone
    app.get('/lessons/:id/similar', async (req, res) => {
      try {
        const { id } = req.params;

        const currentLesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!currentLesson)
          return res.status(404).json({ message: 'Not found' });

        const similarLessons = await lessonsCollection
          .find({
            _id: { $ne: new ObjectId(id) },
            visibility: 'Public',
            $or: [
              { category: currentLesson.category },
              { emotionalTone: currentLesson.emotionalTone },
            ],
          })
          .sort({ createdAt: -1 })
          .limit(6)
          .toArray();

        const result = similarLessons.map(l => ({
          ...l,
          likesCount: l.likes?.length || 0,
        }));

        res.json(result);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    console.log('Archive Ecosystem Online!');
  } catch (err) {
    console.error(err);
  }
}
run().catch(console.dir);
app.get('/', (req, res) => {
  res.send('Server is running fine!');
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
