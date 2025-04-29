import express from 'express';
import { validate } from '../middleware/validate.js';
import { body } from 'express-validator';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';
import { createTeacherModel } from '../models/teacherModel.js';
import pool from '../config/database.js';
import multer from 'multer';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();
const teacherModel = createTeacherModel();

router.use(authenticateToken);

// Configure multer for file upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/teachers/');
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = `${uuidv4()}${path.extname(file.originalname)}`;
        cb(null, uniqueSuffix);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: 10 * 1024 * 1024 // 10MB max file size
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 
            'image/jpg',
            'image/png', 
            'application/pdf', 
            'application/msword', 
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Only JPEG, PNG, PDF, DOC, and DOCX are allowed.'), false);
        }
    }
});


const teacherValidation = [
    body('staff_id').notEmpty().trim(),
    body('first_name').notEmpty().trim(),
    body('last_name').notEmpty().trim(),
    body('email').isEmail(),
    body('phone').notEmpty().trim(),
    body('subject_specialization').isArray()
];

router.use(authenticateToken);

// Get all teachers with comprehensive information
router.get('/', authorizeRoles('admin', 'teacher', 'staff'), async (req, res, next) => {
    try {
        // First, get the current academic session
        const currentSessionQuery = `
            SELECT id
            FROM academic_sessions
            WHERE is_current = true
            LIMIT 1
        `;
        const currentSessionResult = await pool.query(currentSessionQuery);
        const currentSessionId = currentSessionResult.rows[0]?.id;
       
        // Return error if no current session exists
        if (!currentSessionId) {
            return res.status(400).json({
                success: false,
                error: 'No current academic session found'
            });
        }
       
        // Main query to get teacher data with schedule and load information
        const query = `
        WITH daily_classes AS (
            SELECT
                tt.teacher_id,
                CASE tt.day_of_week
                    WHEN 1 THEN 'Monday'
                    WHEN 2 THEN 'Tuesday'
                    WHEN 3 THEN 'Wednesday'
                    WHEN 4 THEN 'Thursday'
                    WHEN 5 THEN 'Friday'
                    WHEN 6 THEN 'Saturday'
                    WHEN 7 THEN 'Sunday'
                END AS day_name,
                json_agg(
                    json_build_object(
                        'class', c.name,
                        'subject', s.name,
                        'start_time', to_char(tt.start_time, 'HH:MI AM'),
                        'end_time', to_char(tt.end_time, 'HH:MI AM'),
                        'room', COALESCE(tt.room_number, 'N/A')
                    )
                ) AS classes
            FROM
                timetable tt
            JOIN
                classes c ON tt.class_id = c.id
            JOIN
                subjects s ON tt.subject_id = s.id
            GROUP BY
                tt.teacher_id, day_name
        ),
        teacher_hour_load AS (
            SELECT
                teacher_id,
                SUM(EXTRACT(EPOCH FROM (end_time - start_time))/3600) AS hours_per_week,
                COUNT(*) AS class_sessions
            FROM
                timetable tt
            GROUP BY
                teacher_id
        ),
        subject_assignments AS (
            SELECT
                teacher_id,
                COUNT(*) AS assigned_subjects
            FROM
                teacher_subjects ts
            GROUP BY
                teacher_id
        )
        SELECT
            t.id,
            (t.first_name || ' ' || t.last_name) AS name,
            t.photo_url AS photo,
            t.email,
            t.phone_primary AS phone,
            t.department,
            t.tsc_number,
            t.education,
            t.employment_type AS "employmentStatus",
            t.subject_specialization AS subjects,
            t.subject_specialization AS qualifications,
            t.joining_date AS "joinDate",
            COALESCE(thl.hours_per_week, 0) AS "currentLoad",
            COALESCE(thl.class_sessions, 0) AS "classSessions",
            COALESCE(sa.assigned_subjects, 0) AS "subjectAssignments",
            40 AS "maxLoad",
            (
                SELECT json_agg(
                    json_build_object(
                        'day', day_name,
                        'classes', classes
                    )
                )
                FROM daily_classes dc
                WHERE dc.teacher_id = t.id
            ) AS schedule
        FROM
            teachers t
        LEFT JOIN
            teacher_hour_load thl ON t.id = thl.teacher_id
        LEFT JOIN
            subject_assignments sa ON t.id = sa.teacher_id
        WHERE
            t.status = 'active'
        ORDER BY
            t.id
    `;
       
        // Execute the query with the current session ID
        const result = await pool.query(query);
       
        // Return the results
        res.json({
            success: true,
            count: result.rows.length,
            data: result.rows
        });
    } catch (error) {
        console.error('Error fetching teachers:', error);
        next(error);
    }
});

// Get single teacher details
router.get('/:id', authorizeRoles('admin', 'teacher', 'staff'), async (req, res, next) => {
    try {
        const teacherId = req.params.id;

        const currentSessionQuery = `
            SELECT id 
            FROM academic_sessions 
            WHERE is_current = true 
            LIMIT 1
        `;

        const currentSessionResult = await pool.query(currentSessionQuery);
        const currentSessionId = currentSessionResult.rows[0]?.id;

        if (!currentSessionId) {
            return res.status(400).json({
                success: false,
                error: 'No current academic session found'
            });
        }

        const query = `
            WITH daily_classes AS (
                SELECT 
                    tt.teacher_id,
                    CASE tt.day_of_week 
                        WHEN 1 THEN 'Monday'
                        WHEN 2 THEN 'Tuesday'
                        WHEN 3 THEN 'Wednesday'
                        WHEN 4 THEN 'Thursday'
                        WHEN 5 THEN 'Friday'
                        WHEN 6 THEN 'Saturday'
                        WHEN 7 THEN 'Sunday'
                    END AS day_name,
                    json_agg(
                        json_build_object(
                            'class', c.name,
                            'subject', s.name,
                            'start_time', to_char(tt.start_time, 'HH:MI AM'),
                            'end_time', to_char(tt.end_time, 'HH:MI AM'),
                            'room', COALESCE(tt.room_number, 'N/A')
                        )
                    ) AS classes
                FROM 
                    timetable tt
                JOIN 
                    classes c ON tt.class_id = c.id
                JOIN 
                    subjects s ON tt.subject_id = s.id
                WHERE
                    tt.teacher_id = $1
                    AND tt.academic_session_id = $2
                GROUP BY 
                    tt.teacher_id, day_name
            ),
            teacher_load AS (
                SELECT 
                    teacher_id, 
                    COUNT(*) AS current_load
                FROM 
                    teacher_subjects ts
                WHERE
                    ts.teacher_id = $1
                    AND ts.academic_session_id = $2
                GROUP BY 
                    teacher_id
            )

            SELECT 
                t.*,
                (t.first_name || ' ' || t.last_name) AS full_name,
                COALESCE(tl.current_load, 0) AS current_teaching_load,
                (
                    SELECT json_agg(
                        json_build_object(
                            'day', day_name,
                            'classes', classes
                        )
                    )
                    FROM daily_classes
                ) AS schedule,
                (
                    SELECT json_agg(
                        json_build_object(
                            'subject_id', ts.subject_id,
                            'subject_name', s.name,
                            'class_id', ts.class_id,
                            'class_name', c.name
                        )
                    )
                    FROM teacher_subjects ts
                    JOIN subjects s ON ts.subject_id = s.id
                    JOIN classes c ON ts.class_id = c.id
                    WHERE ts.teacher_id = t.id
                    AND ts.academic_session_id = $2
                ) AS current_subjects
            FROM 
                teachers t
            LEFT JOIN 
                teacher_load tl ON t.id = tl.teacher_id
            WHERE 
                t.id = $1
        `;

        const result = await pool.query(query, [teacherId, currentSessionId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Teacher not found'
            });
        }
        
        res.json({
            success: true,
            data: result.rows[0]
        });
    } catch (error) {
        console.error(`Error fetching teacher with ID ${req.params.id}:`, error);
        next(error);
    }
});

// Add new teacher
router.post('/', 
    authorizeRoles('admin'),
    upload.array('documents', 5), // Allow multiple file uploads
    async (req, res, next) => {
        const client = await pool.connect();
        
        try {
            // Extract form data
            const {
                first_name,
                last_name,
                id_number,
                email,
                phone_primary,
                phone_secondary,
                tsc_number,
                joining_date,
                employment_type,
                department,
                subject_specialization,
                education,
                certifications,
                experience,
                status = 'active',
                gender, // Extract gender
                documents
            } = req.body;

            console.log(req.body);

            // Validate required fields
            const requiredFields = [
                'first_name', 'last_name', 'email', 
                'phone_primary', 'tsc_number', 
                'joining_date', 'employment_type', 'gender' // Added gender validation
            ];
            
            for (let field of requiredFields) {
                if (!req.body[field]) {
                    return res.status(400).json({
                        success: false,
                        error: `Missing required field: ${field}`
                    });
                }
            }

            // Validate gender
            const validGenders = ['male', 'female', 'other'];
            if (!validGenders.includes(gender.toLowerCase())) {
                return res.status(400).json({
                    success: false,
                    error: 'Invalid gender. Allowed values: male, female, other'
                });
            }

            // Generate staff ID
            const staffIdQuery = `
                SELECT COALESCE(
                    MAX(CAST(SUBSTRING(staff_id FROM '[0-9]+') AS INTEGER)), 0
                ) + 1 AS next_id 
                FROM teachers
            `;
            const staffIdResult = await client.query(staffIdQuery);
            const staffId = `TSC${staffIdResult.rows[0].next_id.toString().padStart(4, '0')}`;

            // Handle photo and file uploads
            const photoFile = req.files.find(file => 
                ['image/jpeg', 'image/png'].includes(file.mimetype)
            );
            const photoUrl = photoFile 
                ? `/uploads/teachers/${photoFile.filename}` 
                : null;

            // Process document uploads
            const uploadedFiles = req.files
                .filter(file => file !== photoFile)
                .map(file => ({
                    url: `/uploads/teachers/${file.filename}`,
                    name: file.originalname,
                    type: file.mimetype,
                    size: file.size
                }));

            // Prepare subject specialization
            const subjectSpec = Array.isArray(subject_specialization) 
                ? subject_specialization 
                : (subject_specialization ? subject_specialization.split(',') : []);

            // Prepare documents (merge uploaded files with existing document metadata)
            const documentDetails = documents 
                ? JSON.parse(documents).concat(uploadedFiles)
                : uploadedFiles;

            // Insert teacher
            const insertTeacherQuery = `
                INSERT INTO teachers (
                    staff_id,
                    first_name,
                    last_name,
                    id_number,
                    tsc_number,
                    email,
                    phone_primary,
                    phone_secondary,
                    joining_date,
                    employment_type,
                    department,
                    subject_specialization,
                    education,
                    certifications,
                    experience,
                    documents,
                    photo_url,
                    status,
                    gender
                ) VALUES (
                    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
                    $11, $12, $13, $14, $15, $16, $17, $18, $19
                ) RETURNING id
            `;

            const teacherValues = [
                staffId,
                first_name,
                last_name,
                id_number,
                tsc_number,
                email,
                phone_primary,
                phone_secondary || null,
                joining_date,
                employment_type,
                department,
                subjectSpec,
                education,
                certifications,
                experience,
                JSON.stringify(documentDetails),
                photoUrl,
                status,
                gender.toLowerCase() // Store gender in lowercase
            ];

            const teacherResult = await client.query(
                insertTeacherQuery, 
                teacherValues
            );
            const teacherId = teacherResult.rows[0].id;

            // Commit transaction
            await client.query('COMMIT');

            // Return success response
            res.status(201).json({
                success: true,
                message: 'Teacher added successfully',
                data: {
                    id: teacherId,
                    staff_id: staffId,
                    name: `${first_name} ${last_name}`,
                    gender: gender.toLowerCase()
                }
            });
        } catch (error) {
            // Rollback transaction
            await client.query('ROLLBACK');
            
            console.error('Error adding teacher:', error);
            
            // Check for unique constraint violations
            if (error.code === '23505') {
                return res.status(400).json({
                    success: false,
                    error: 'A teacher with this email, ID number, or TSC number already exists'
                });
            }
            
            next(error);
        } finally {
            client.release();
        }
    }
);


// Get available substitute teachers for a date range
router.get('/check/available-substitutes', authorizeRoles("admin", "teacher"),  async (req, res) => {
    try {
      const { start_date, end_date, exclude_teacher_id } = req.query;
      console.log(req.query)
      if (!start_date || !end_date) {
        return res.status(400).json({ 
          message: 'Start date and end date are required' 
        });
      }
      
      // Find teachers who are not on leave during the specified period
      const query = `
        SELECT 
          t.id, 
          t.first_name || ' ' || t.last_name AS full_name,
          t.staff_id,
          t.photo_url,
          t.department,
          t.subject_specialization
        FROM teachers t
        WHERE t.status = 'active'
        AND t.id != $1
        AND NOT EXISTS (
          SELECT 1
          FROM leave_requests lr
          WHERE lr.teacher_id = t.id
          AND lr.status = 'approved'
          AND (
            (lr.start_date <= $2 AND lr.end_date >= $2)
            OR (lr.start_date <= $3 AND lr.end_date >= $3)
            OR (lr.start_date >= $2 AND lr.end_date <= $3)
          )
        )
        ORDER BY t.first_name, t.last_name
      `;
      
      const result = await pool.query(query, [
        exclude_teacher_id || 0,
        start_date,
        end_date
      ]);
      
      res.json(result.rows);
    } catch (error) {
      console.error('Error fetching available substitute teachers:', error);
      res.status(500).json({ message: 'Server error' });
    }
  });

// Update existing teacher
router.put('/:id', 
    authorizeRoles("admin", "teacher"),
    upload.array('documents', 5),
    async (req, res, next) => {
        const client = await pool.connect();
        console.log(req.body);
        try {
            const teacherId = req.params.id;
            
            // Extract form data
            const {
                name,
                email,
                phone,
                position,
                department,
                employmentStatus,
                subjects,
                qualifications,
                id
            } = req.body;

            // Split name into first and last name
            const nameParts = name.split(' ');
            const first_name = nameParts[0];
            const last_name = nameParts.slice(1).join(' ');

            // Validate required fields
            const requiredFields = [
                'name', 'email', 'phone', 
                'department', 'employmentStatus'
            ];
            
            for (let field of requiredFields) {
                if (!req.body[field]) {
                    return res.status(400).json({
                        success: false,
                        error: `Missing required field: ${field}`
                    });
                }
            }

            // Check if teacher exists
            const checkTeacherQuery = `
                SELECT * FROM teachers WHERE id = $1
            `;
            const teacherCheck = await client.query(checkTeacherQuery, [teacherId]);
            
            if (teacherCheck.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    error: 'Teacher not found'
                });
            }

            // Check for email conflicts (excluding current teacher)
            const emailCheckQuery = `
                SELECT id FROM teachers 
                WHERE email = $1 AND id != $2
            `;
            const existingEmailCheck = await client.query(emailCheckQuery, [email, teacherId]);
            
            if (existingEmailCheck.rows.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: `A teacher with email ${email} already exists.`
                });
            }

            // Update teacher query
            const updateTeacherQuery = `
                UPDATE teachers SET
                    first_name = $1,
                    last_name = $2,
                    email = $3,
                    phone_primary = $4,
                    department = $5,
                    employment_type = $6,
                    subject_specialization = $7,
                    updated_at = NOW()
                WHERE id = $8
                RETURNING id
            `;

            const teacherValues = [
                first_name,
                last_name,
                email,
                phone,
                department,
                employmentStatus.toLowerCase().replace(' ', '-'),
                subjects || [],
                teacherId
            ];

            const updateResult = await client.query(
                updateTeacherQuery, 
                teacherValues
            );

            // Commit transaction
            await client.query('COMMIT');

            // Return success response
            res.json({
                success: true,
                message: 'Teacher updated successfully',
                data: {
                    id: teacherId,
                    name: name
                }
            });
        } catch (error) {
            // Rollback transaction
            await client.query('ROLLBACK');
            
            console.error('Error updating teacher:', error);
            
            // Check for unique constraint violations
            if (error.code === '23505') {
                return res.status(400).json({
                    success: false,
                    error: 'A teacher with this email or other unique identifier already exists'
                });
            }
            
            next(error);
        } finally {
            client.release();
        }
    }
);

router.delete("/:id", authorizeRoles("admin"), async (req, res) => {
    const { id } = req.params;
      console.log(id)
    try {
      // Delete the teacher record
      const result = await pool.query("DELETE FROM teachers WHERE id = $1 RETURNING *", [id]);
  
      if (result.rowCount === 0) {
        return res.status(404).json({ message: "Teacher not found" });
      }
  
      res.status(200).json({ message: "Teacher deleted successfully", deletedTeacher: result.rows[0] });
    } catch (error) {
      console.error("Error deleting teacher:", error);
      res.status(500).json({ message: "Internal server error" });
    }
  });

export default router;