// src/routes/auth.routes.js
import express from 'express';
import { validate } from '../middleware/validate.js';
import { body } from 'express-validator';
import { createUserModel } from '../models/userModel.js';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, JWT_EXPIRES_IN } from '../config/constants.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import pool from '../config/database.js';

const router = express.Router();
const userModel = createUserModel();

// Validation rules
const loginValidation = [
    body('username').notEmpty().trim()
        .withMessage('Username is required'),
    body('password').notEmpty()
        .withMessage('Password is required')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long')
];

const createUserValidation = [
    body('username')
        .notEmpty()
        .trim()
        .withMessage('Username is required')
        .isLength({ min: 3 })
        .withMessage('Username must be at least 3 characters long'),
    body('password')
        .notEmpty()
        .withMessage('Password is required')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long')
        .matches(/\d/)
        .withMessage('Password must contain at least one number'),
    body('email')
        .isEmail()
        .withMessage('Must be a valid email address')
        .normalizeEmail(),
    body('role')
        .isIn(['admin', 'teacher', 'student', 'parent', 'staff'])
        .withMessage('Invalid role specified')
];

// Create user route
router.post('/register', 
    authenticateToken, 
    authorizeRoles('admin'),
    validate(createUserValidation),
    async (req, res, next) => {
        try {
            const { username, password, email, role } = req.body;

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

            // Create new user with password hashing
            // Note: The createUser method in userModel handles password hashing internally
            const result = await userModel.createUser({
                username,
                password, // This will be hashed inside createUser method
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
    }
);

// Login route
router.post('/login', validate(loginValidation), async (req, res, next) => {
    try {
        const { username, password } = req.body;
        console.log(req.body)
        const result = await userModel.findByUsername(username);
        const user = result.rows[0];
         console.log(user)
        if (!user || !(await userModel.validatePassword(user.password_hash, password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign(
            { 
                id: user.id,
                username: user.username,
                role: user.role 
            },
            JWT_SECRET,
            { expiresIn: JWT_EXPIRES_IN }
        );

        await userModel.update(user.id, { 
            last_login: new Date() 
        });

        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        next(error);
    }
});

// Logout route
router.post('/logout', authenticateToken, async (req, res, next) => {
    try {
        await userModel.update(req.user.id, {
            last_logout: new Date()
        });

        res.json({ 
            message: 'Logout successful'
        });
    } catch (error) {
        next(error);
    }
});


// Verify token route
router.get('/verify-token', authenticateToken, async (req, res, next) => {
    try {
        // If the authenticateToken middleware passes, the token is valid
        // and req.user contains the decoded token payload
        const userResult = await userModel.findById(req.user.id);
        
        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Return user data without sensitive information
        const { password_hash, ...userData } = userResult.rows[0];
        
        res.json({ 
            valid: true,
            user: userData
        });
    } catch (error) {
        next(error);
    }
});


router.get('/user-profile',  authenticateToken, async (req, res) => {
    try {
      const userId = req.user.id; // From authentication middleware
      const userRole = req.user.role.toLowerCase();
      
      let profileData = {
        profile_type: userRole
      };
      
      // Check if user has a teacher profile regardless of role
      const teacherQuery = `
        SELECT 
          t.id as teacher_id,
          t.staff_id,
          t.first_name,
          t.last_name,
          t.email,
          t.phone_primary as phone,
          t.department,
          t.photo_url,
          t.employment_type,
          t.status,
          t.subject_specialization
        FROM 
          teachers t
        WHERE 
          t.user_id = $1
      `;
      
      const teacherResult = await pool.query(teacherQuery, [userId]);
      
      // If user has a teacher profile, add it to the response
      if (teacherResult.rows.length > 0) {
        profileData.teacher = teacherResult.rows[0];
        profileData.teacherId = teacherResult.rows[0].teacher_id;
      }
      
      // If user is specifically a teacher role, set the profile type to teacher
      if (userRole === 'teacher') {
        profileData.profile_type = 'teacher';
      }
      
      // Return the appropriate profile
      res.json({
        success: true,
        user: {
          id: req.user.id,
          username: req.user.username,
          email: req.user.email,
          role: req.user.role,
          ...profileData
        }
      });
    } catch (error) {
      console.error('Error fetching user profile:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Server error',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
      });
    }
  });

export default router;