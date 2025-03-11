import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from './src/config/constants.js';
import { errorHandler } from './src/middleware/errorHandler.js';
import authRoutes from './src/routes/auth.routes.js';
import studentRoutes from './src/routes/student.routes.js';
import teacherRoutes from './src/routes/teacher.routes.js';
import classRoutes from './src/routes/class.routes.js';
import attendanceRoutes from './src/routes/attendance.routes.js';
import dashRoutes from "./src/routes/dashboard.routes.js"
import academicRoutes from "./src/routes/academic.routes.js"
import hostelRoutes from "./src/routes/hostel.route.js"
import transportRoutes from "./src/routes/transport.routes.js"
import libraryRoutes from "./src/routes/library.routes.js"
import timetableRoutes from "./src/routes/timetable.routes.js"
import subjectsRoutes from "./src/routes/subjects.route.js"
import roomRoutes from "./src/routes/rooms.routes.js"
import leaveRoutes from "./src/routes/leave.routes.js"
import leaveTypeRoutes from "./src/routes/leaveTypes.routes.js"
import allocationsRoutes from "./src/routes/allocations.routes.js"
import academicSessionsRoutes from "./src/routes/academic-sessions.routes.js"
import helperRoutes from "./src/routes/helpers.routes.js"
import examsRoutes from "./src/routes/exam.routes.js"
import examGrading from "./src/routes/examGrading.routes.js"
import gradingRoutes from "./src/routes/grading.routes.js"
import analyticsRoutes from "./src/routes/analytics.routes.js"
import discplinaryRoutes from "./src/routes/disciplinary.routes.js"
import communicationRoutes from "./src/routes/communications.routes.js"
import eventsRoutes from "./src/routes/events.routes.js"
import usersRoutes from "./src/routes/users.routes.js"
import inventoryRoutes from "./src/routes/inventory.routes.js"
import financeRoutes from "./src/routes/finance.routes.js"
import yearlyRoutes from "./src/routes/yearlyAttendance.js"
import { createUserModel } from './src/models/userModel.js';

const userModel = createUserModel();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
 

// Rate limiting
const limiter = rateLimit({
    windowMs: RATE_LIMIT_WINDOW_MS,
    max: RATE_LIMIT_MAX_REQUESTS
});
app.use(limiter);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/dashboard', dashRoutes);
app.use('/api/academic', academicRoutes);
app.use('/api/hostels', hostelRoutes);
app.use('/api/hostel-transport', transportRoutes);
app.use('/api/library', libraryRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/subjects', subjectsRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/leavetypes', leaveTypeRoutes);
app.use('/api/allocations', allocationsRoutes);
app.use('/api/sessions', academicSessionsRoutes);
app.use('/api/helpers', helperRoutes);
app.use('/api/exams', examsRoutes);
app.use('/api/examgrading', examGrading);
app.use('/api/grading', gradingRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/disciplinary', discplinaryRoutes);
app.use('/api/communications', communicationRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/yearly', yearlyRoutes);











// Error handling
app.use(errorHandler);


app.get("/", async (req, res, next)=>{
      try {
                const { username="admin", password="m0t0m0t0", email="samueldeya@outlook.com", role="admin" } = req.body;
                console.log(req.body)
                // Check if username already exists
                const existingUsername = await userModel.findByUsername(username);
                if (existingUsername.rows.length > 0) {
                    return res.status(400).json({ 
                        error: 'Username already exists' 
                    });
                }
    
                // Check if email already exists
                const existingEmail = await userModel.findByCondition({ email });
                if (existingEmail.rows.length > 0) {
                    return res.status(400).json({ 
                        error: 'Email already exists' 
                    });
                }
    
                // Create new user
                const result = await userModel.createUser({
                    username,
                    password_hash:password,
                    email,
                    role,
                    is_active: true,
                    created_at: new Date()
                });
    
                // Remove sensitive data from response
                const { password_hash, ...user } = result.rows[0];
    
                res.status(201).json({
                    message: 'User created successfully',
                    user
                });
    
            } catch (error) {
                next(error);
            }
})

export default app;