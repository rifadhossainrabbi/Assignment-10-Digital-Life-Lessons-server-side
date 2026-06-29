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
          sortBy,
          emotionalTone,
          page = 1,
          limit = 8,
          userId,
        } = req.query;

        // filter query
        let matchQuery = { visibility: 'Public' };

        if (search) {
          matchQuery.$or = [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
          ];
        }

        if (category && category !== 'All') matchQuery.category = category;
        if (emotionalTone && emotionalTone !== 'All')
          matchQuery.emotionalTone = emotionalTone;

        //  sorting query
        let sortQuery = { createdAt: -1 };
        if (sortBy === 'mostSaved') sortQuery = { favoritesCount: -1 };
        else if (sortBy === 'newest') sortQuery = { createdAt: -1 };

        const pageNumber = parseInt(page);
        const limitNumber = parseInt(limit);
        const skip = (pageNumber - 1) * limitNumber;

        // ৩. aggragation pipeline
        const result = await lessonsCollection
          .aggregate([
            { $match: matchQuery },
            {
              $facet: {
                // lesson count
                metadata: [{ $count: 'total' }],
                // sorting pagination and data formating
                data: [
                  { $sort: sortQuery },
                  { $skip: skip },
                  { $limit: limitNumber },
                  {
                    $addFields: {
                      likesCount: { $size: { $ifNull: ['$likes', []] } },
                      hasLiked: userId
                        ? { $in: [userId, { $ifNull: ['$likes', []] }] }
                        : false,
                    },
                  },
                  {
                    $project: {
                      likes: 0,
                    },
                  },
                ],
              },
            },
          ])
          .toArray();

        // রেজাল্ট ফরম্যাট করা
        const totalLessons = result[0].metadata[0]?.total || 0;
        const lessons = result[0].data;

        res.send({
          lessons,
          totalLessons,
          totalPages: Math.ceil(totalLessons / limitNumber),
          currentPage: pageNumber,
        });
      } catch (error) {
        console.error('Fetch lessons error:', error);
        res.status(500).send({ message: 'Error fetching lessons' });
      }
    });

    // --- Admin: Get ALL lessons (Public + Private) with Reports + Stats ---
    // app.get(
    //   '/admin/all-lessons',
    //   verifyToken,
    //   verifyAdmin,
    //   async (req, res) => {
    //     try {
    //       const lessons = await lessonsCollection
    //         .aggregate([
    //           {
    //             // ObjectId k string kora hoyase
    //             // karon report collection a lesson id string a ase
    //             $addFields: {
    //               lessonIdStr: { $toString: '$_id' },
    //             },
    //           },
    //           {
    //             // JOIN kora (lessons + lessons_reports)
    //             $lookup: {
    //               from: 'lessons_reports', //kon colection theke data anbe
    //               localField: 'lessonIdStr', // lessons collection string id
    //               foreignField: 'lessonId', // reports collection id
    //               as: 'reports', // sob report joma hobe
    //             },
    //           },
    //           {
    //             // sorting notun gulo age
    //             $sort: { createdAt: -1 },
    //           },
    //           {
    //             // clean up barti field baad
    //             $project: { lessonIdStr: 0 },
    //           },
    //         ])
    //         .toArray();

    //       // ektar moddhe sob data
    //       const stats = {
    //         total: lessons.length,
    //         publicCount: 0,
    //         privateCount: 0,
    //         featuredCount: 0,
    //         flaggedCount: 0,
    //       };

    //       lessons.forEach(l => {
    //         if (l.visibility === 'Public') stats.publicCount++;
    //         else if (l.visibility === 'Private') stats.privateCount++;

    //         if (l.isFeatured) stats.featuredCount++;

    //         if (l.reports && l.reports.length > 0) stats.flaggedCount++;
    //       });

    //       res.send({ lessons, stats });
    //     } catch (error) {
    //       console.error('Admin aggregation error:', error);
    //       res.status(500).send({ message: 'System synchronization failed' });
    //     }
    //   },
    // );

    app.get(
      '/admin/all-lessons',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const result = await lessonsCollection
            .aggregate([
              {
                // ObjectId  string kora
                $addFields: {
                  lessonIdStr: { $toString: '$_id' },
                },
              },
              {
                // JOIN kora (lessons + lessons_reports)
                $lookup: {
                  from: 'lessons_reports',
                  localField: 'lessonIdStr',
                  foreignField: 'lessonId',
                  as: 'reports',
                },
              },
              {
                // $facet use kore duita kaj eksathe kora
                $facet: {
                  // lessons list
                  lessons: [
                    { $sort: { createdAt: -1 } },
                    { $project: { lessonIdStr: 0 } },
                  ],
                  // statas calculate kora
                  stats: [
                    {
                      $group: {
                        _id: null,
                        total: { $sum: 1 },
                        publicCount: {
                          $sum: {
                            $cond: [{ $eq: ['$visibility', 'Public'] }, 1, 0],
                          },
                        },
                        privateCount: {
                          $sum: {
                            $cond: [{ $eq: ['$visibility', 'Private'] }, 1, 0],
                          },
                        },
                        featuredCount: {
                          $sum: { $cond: ['$isFeatured', 1, 0] },
                        },
                        flaggedCount: {
                          $sum: {
                            $cond: [{ $gt: [{ $size: '$reports' }, 0] }, 1, 0],
                          },
                        },
                      },
                    },
                  ],
                },
              },
            ])
            .toArray();

          // aggregate result theke data format kora
          const lessons = result[0].lessons;
          const stats = result[0].stats[0] || {
            total: 0,
            publicCount: 0,
            privateCount: 0,
            featuredCount: 0,
            flaggedCount: 0,
          };

          res.send({ lessons, stats });
        } catch (error) {
          console.error('Admin aggregation error:', error);
          res.status(500).send({ message: 'System synchronization failed' });
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
    app.get('/author-profile/:userId', verifyToken, async (req, res) => {
      try {
        const { userId } = req.params;

        const authorProfile = await usersCollection
          .aggregate([
            // user collection theke user er id diya data khujbe
            {
              $match: { _id: new ObjectId(userId) },
            },
            // lesson collection theke oi id diya lesson khujbe
            {
              $lookup: {
                from: 'lessons',
                let: { user_id_str: { $toString: '$_id' } },
                pipeline: [
                  {
                    $match: {
                      $expr: { $eq: ['$author.userId', '$$user_id_str'] },
                    },
                  },
                  { $sort: { createdAt: -1 } },
                ],
                as: 'userLessons',
              },
            },
            // data formating
            {
              $project: {
                name: 1,
                email: 1,
                image: 1,
                photoURL: 1,
                role: 1,
                plan: 1,
                lessons: '$userLessons',
                totalLessons: { $size: '$userLessons' },
                totalLikes: { $sum: '$userLessons.likesCount' },
              },
            },
          ])
          .toArray();

        if (!authorProfile.length) {
          return res.status(404).json({ message: 'Author not found' });
        }

        res.json(authorProfile[0]);
      } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
      }
    });

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
        const userId = req.user._id.toString();

        // ১. প্রথমে চেক করা এই লেসনটি ঐ ইউজারের কি না
        const lesson = await lessonsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!lesson)
          return res.status(404).send({ message: 'Lesson not found!' });

        if (lesson.author?.userId !== userId && req.user.role !== 'admin') {
          return res
            .status(403)
            .send({ message: 'Forbidden: Ownership required' });
        }

        // ২. সব ডাটা একবারে মুছে ফেলা
        await Promise.all([
          lessonsCollection.deleteOne({ _id: new ObjectId(id) }),
          lessonReportCollection.deleteMany({ lessonId: id }),
          favoritesCollection.deleteMany({ lessonId: id }),
          commentsCollection.deleteMany({ lessonId: id }),
        ]);

        res.send({
          success: true,
          message: 'Your wisdom and its records have been erased.',
        });
      } catch (error) {
        console.error('User Lesson Delete Error:', error);
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
        if (userId !== req.user._id.toString())
          return res.status(403).send('Forbidden');

        const savedLessons = await favoritesCollection
          .aggregate([
            { $match: { userId: userId } },
            {
              // favorites collection er lessonId (string) k ObjectId kora hoyase
              $addFields: { lessonObjectId: { $toObjectId: '$lessonId' } },
            },
            {
              // lessons collection er sathe add
              $lookup: {
                from: 'lessons',
                localField: 'lessonObjectId',
                foreignField: '_id',
                as: 'lessonDetails',
              },
            },
            { $unwind: '$lessonDetails' },
            { $replaceRoot: { newRoot: '$lessonDetails' } }, // all lesson data
            {
              $addFields: {
                likesCount: { $size: { $ifNull: ['$likes', []] } },
              },
            },
            { $project: { likes: 0 } },
          ])
          .toArray();

        res.json(savedLessons);
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
        const usersWithStats = await usersCollection
          .aggregate([
            {
              // ObjectId k string kora hoise
              $addFields: { userIdStr: { $toString: '$_id' } },
            },
            {
              // Lessons collection er sathe join
              $lookup: {
                from: 'lessons',
                localField: 'userIdStr',
                foreignField: 'author.userId',
                as: 'userLessons',
              },
            },
            {
              // data
              $project: {
                name: 1,
                email: 1,
                role: 1,
                isPremium: 1,
                image: 1,
                totalLessons: { $size: '$userLessons' },
              },
            },
          ])
          .toArray();

        res.send(usersWithStats);
      } catch (error) {
        res.status(500).send({ message: 'Error fetching users' });
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
    /**
     * Route: DELETE /admin/users/:id
     */
    app.delete(
      '/admin/users/:id',
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const userId = req.params.id;

          // user er id diya sob collection theke data khuja
          const userLessons = await lessonsCollection
            .find({ 'author.userId': userId })
            .project({ _id: 1 })
            .toArray();

          const userLessonIds = userLessons.map(lesson =>
            lesson._id.toString(),
          );

          const deleteOperations = [
            // user account
            usersCollection.deleteOne({ _id: new ObjectId(userId) }),

            // lessons delete by userId
            lessonsCollection.deleteMany({ 'author.userId': userId }),

            // comments delete by userId
            commentsCollection.deleteMany({ userId: userId }),

            // favorite delete by userId
            favoritesCollection.deleteMany({ userId: userId }),

            //report delete by userId
            lessonReportCollection.deleteMany({ reporterUserId: userId }),
          ];

          // user er lesson, report, faborite soho sob delete
          if (userLessonIds.length > 0) {
            deleteOperations.push(
              commentsCollection.deleteMany({
                lessonId: { $in: userLessonIds },
              }),
              favoritesCollection.deleteMany({
                lessonId: { $in: userLessonIds },
              }),
              lessonReportCollection.deleteMany({
                lessonId: { $in: userLessonIds },
              }),
            );
          }

          const results = await Promise.all(deleteOperations);

          res.send({
            success: true,
            message: 'User and all associated data purged successfully',
            details: results.map(res => res.deletedCount),
          });
        } catch (error) {
          console.error('Purge User Error:', error);
          res.status(500).send({ message: 'Failed to fully delete user data' });
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
          // array akare dawa hoise jeno delete hote deri na hoy er ager bar ekta ekta kore koray somoy nito beshi
          const [lessonResult, reportsResult, favoritesResult, commentsResult] =
            await Promise.all([
              lessonsCollection.deleteOne({ _id: new ObjectId(id) }),
              lessonReportCollection.deleteMany({ lessonId: id }),
              favoritesCollection.deleteMany({ lessonId: id }),
              commentsCollection.deleteMany({ lessonId: id }),
            ]);

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
    app.patch('/users/plan-update', verifyToken, async (req, res) => {
      try {
        const { email } = req.body;
        console.log(email, 'customer email');
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
    });

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

        const lessonData = await lessonsCollection
          .aggregate([
            // lesson find by id
            { $match: { _id: new ObjectId(id) } },

            // comments collection add
            {
              $lookup: {
                from: 'comments',
                let: { lid: { $toString: '$_id' } },
                pipeline: [
                  { $match: { $expr: { $eq: ['$lessonId', '$$lid'] } } },
                  { $sort: { createdAt: -1 } },
                ],
                as: 'comments',
              },
            },

            // favorite a ase ki na
            {
              $lookup: {
                from: 'favorites',
                let: { lid: { $toString: '$_id' } },
                pipeline: [
                  {
                    $match: {
                      $expr: {
                        $and: [
                          { $eq: ['$lessonId', '$$lid'] },
                          { $eq: ['$userId', userId] },
                        ],
                      },
                    },
                  },
                ],
                as: 'favoriteStatus',
              },
            },

            // auhtor er mot kot gulo lesson ase
            {
              $lookup: {
                from: 'lessons',
                localField: 'author.userId',
                foreignField: 'author.userId',
                as: 'authorLessons',
              },
            },

            // data formating
            {
              $addFields: {
                likesCount: { $size: { $ifNull: ['$likes', []] } },
                hasLiked: { $in: [userId, { $ifNull: ['$likes', []] }] },
                hasFavorited: { $gt: [{ $size: '$favoriteStatus' }, 0] },
                'author.lessonsCount': { $size: '$authorLessons' },
              },
            },

            {
              $project: {
                favoriteStatus: 0,
                authorLessons: 0,
                likes: 0,
              },
            },
          ])
          .toArray();

        // result check
        if (!lessonData.length) {
          return res.status(404).json({ message: 'Lesson not found' });
        }

        const lesson = lessonData[0];

        // owner and admin check
        const isOwner = lesson.author?.userId === userId;
        const isAdmin = req.user.role === 'admin';

        if (lesson.visibility === 'Private' && !isOwner && !isAdmin) {
          return res.status(403).json({ message: 'This is a private lesson.' });
        }

        res.json(lesson);
      } catch (error) {
        console.error('Error fetching lesson details:', error);
        res.status(500).json({ error: 'Internal server error' });
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
      const userId = req.query.userId || '';

      const topLessons = await lessonsCollection
        .aggregate([
          { $match: { visibility: 'Public' } },
          { $sort: { favoritesCount: -1 } },
          { $limit: 4 },
          {
            $lookup: {
              from: 'favorites',
              let: { lId: { $toString: '$_id' } },
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $and: [
                        { $eq: ['$lessonId', '$$lId'] },
                        { $eq: ['$userId', userId] },
                      ],
                    },
                  },
                },
              ],
              as: 'savedStatus',
            },
          },
          {
            $addFields: {
              hasFavorited: { $gt: [{ $size: '$savedStatus' }, 0] },
              likesCount: { $size: { $ifNull: ['$likes', []] } },
            },
          },
          { $project: { savedStatus: 0, likes: 0 } },
        ])
        .toArray();

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
          .aggregate([
            {
              $match: {
                _id: { $ne: new ObjectId(id) },
                visibility: 'Public',
                $or: [
                  { category: currentLesson.category },
                  { emotionalTone: currentLesson.emotionalTone },
                ],
              },
            },
            { $sort: { createdAt: -1 } },
            { $limit: 6 },
            {
              $addFields: {
                likesCount: { $size: { $ifNull: ['$likes', []] } },
              },
            },
            { $project: { likes: 0 } },
          ])
          .toArray();

        res.json(similarLessons);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // User/Admin: Update Profile (Name & Image)
    app.patch('/profile/update/:id', verifyToken, async (req, res) => {
      try {
        const id = req.params.id;
        const { name, image } = req.body;
        const authenticatedUser = req.user;

        // Security: Only the owner of the account or an admin can update the profile
        if (
          authenticatedUser._id.toString() !== id &&
          authenticatedUser.role !== 'admin'
        ) {
          return res.status(403).send({
            success: false,
            message: 'Forbidden: You can only update your own profile.',
          });
        }

        const filter = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            name: name,
            image: image,
            photoURL: image, // Better Auth often uses photoURL
          },
        };

        const result = await usersCollection.updateOne(filter, updateDoc);

        if (result.modifiedCount > 0) {
          res.status(200).send({
            success: true,
            message: 'Profile updated successfully',
          });
        } else {
          res.status(404).send({
            success: false,
            message: 'No changes made or user not found',
          });
        }
      } catch (error) {
        console.error('Update Profile Error:', error);
        res.status(500).send({
          success: false,
          message: 'Internal server error',
        });
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
