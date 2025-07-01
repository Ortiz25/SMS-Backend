import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// GET /students - fetch all active students
router.get('/students', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { class_name, stream, status = 'active' } = req.query;
    
    let query = `
      SELECT 
        s.id,
        s.admission_number,
        s.first_name,
        s.last_name,
        s.other_names,
        s.current_class,
        s.stream,
        s.curriculum_type,
        s.status,
        s.student_type,
        s.date_of_birth,
        s.gender
      FROM students s
      WHERE s.status = $1
    `;
    
    const queryParams = [status];
    
    // Add filters if provided
    if (class_name) {
      queryParams.push(class_name);
      query += ` AND s.current_class = $${queryParams.length}`;
    }
    
    if (stream) {
      queryParams.push(stream);
      query += ` AND s.stream = $${queryParams.length}`;
    }
    
    query += ` ORDER BY s.current_class, s.stream, s.last_name, s.first_name`;
    
    const result = await pool.query(query, queryParams);
    
    res.json({
      success: true,
      data: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching students:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching students',
      error: error.message 
    });
  }
});

// GET /classes - fetch available classes and streams
router.get('/classes', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
    try {
      const { curriculum_type } = req.query;
      
      // Get all individual classes with their streams
      let query = `
        SELECT 
          c.id,
          c.name,
          c.curriculum_type,
          c.level,
          c.stream,
          c.academic_session_id
        FROM classes c
      `;
      
      const queryParams = [];
      
      if (curriculum_type) {
        queryParams.push(curriculum_type);
        query += ` AND c.curriculum_type = $${queryParams.length}`;
      }
      
      query += ` ORDER BY c.level, c.name, c.stream`;
      
      const result = await pool.query(query, queryParams);
      
      // Group classes by level and name for frontend display
      const classesMap = new Map();
      
      result.rows.forEach(cls => {
        const key = `${cls.level}_${cls.curriculum_type}`;
        
        if (!classesMap.has(key)) {
          classesMap.set(key, {
            level: cls.level,
            name: cls.name, // This should be like "Form 3" not "Form 3 Arts"
            curriculum_type: cls.curriculum_type,
            streams: []
          });
        }
        
        if (cls.stream && !classesMap.get(key).streams.includes(cls.stream)) {
          classesMap.get(key).streams.push(cls.stream);
        }
      });
      
      const classes = Array.from(classesMap.values());
      
      // Also get current academic session info
      const sessionQuery = `
        SELECT id, year, term, is_current 
        FROM academic_sessions 
        WHERE is_current = true 
        LIMIT 1
      `;
      const sessionResult = await pool.query(sessionQuery);
      
      res.json({
        success: true,
        data: {
          classes: classes,
          currentSession: sessionResult.rows[0] || null
        }
      });
    } catch (error) {
      console.error('Error fetching classes:', error);
      res.status(500).json({ 
        success: false,
        message: 'Server error while fetching classes',
        error: error.message 
      });
    }
  });

  router.post('/promote-student', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        student_id,
        new_class_name, // This is now the level (e.g., "Form 3")
        new_stream,
        promotion_status = 'promoted',
        remarks
      } = req.body;
      
      // Validate required fields
      if (!student_id || !new_class_name) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields',
          required: ['student_id', 'new_class_name']
        });
      }
      
      // Validate promotion status
      const validStatuses = ['promoted', 'repeated', 'transferred', 'graduated'];
      if (!validStatuses.includes(promotion_status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid promotion status',
          validStatuses
        });
      }
      
      // Check if student exists and get current info
      const studentQuery = `
        SELECT id, admission_number, first_name, last_name, current_class, stream, status
        FROM students 
        WHERE id = $1 AND status = 'active'
      `;
      const studentResult = await client.query(studentQuery, [student_id]);
      
      if (studentResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Student not found or not active'
        });
      }
      
      const student = studentResult.rows[0];
      
      // Get current academic session
      const sessionQuery = `
        SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1
      `;
      const sessionResult = await client.query(sessionQuery);
      
      if (sessionResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'No current academic session found. Please set up the new academic session first.'
        });
      }
      
      const currentSessionId = sessionResult.rows[0].id;
      
      // Archive current class in history (manual implementation since we're updating the level)
      const historyQuery = `
        INSERT INTO student_class_history (
          student_id,
          academic_session_id,
          class_id,
          class_name,
          stream,
          promotion_status,
          promoted_on,
          promoted_by,
          remarks
        ) VALUES (
          $1,
          $2,
          (SELECT id FROM classes WHERE level = $3 AND academic_session_id = $2 LIMIT 1),
          $3,
          $4,
          $5,
          CURRENT_DATE,
          $6,
          $7
        )
      `;
      
      await client.query(historyQuery, [
        student_id,
        currentSessionId,
        student.current_class,
        student.stream,
        promotion_status,
        req.user.id,
        remarks
      ]);
      
      // Update student's current class to the new level
      const updateQuery = `
        UPDATE students 
        SET 
          current_class = $1,
          stream = $2,
          status = CASE WHEN $3 = 'graduated' THEN 'graduated' ELSE status END,
          updated_at = NOW()
        WHERE id = $4
      `;
      
      await client.query(updateQuery, [
        new_class_name, // This is the level (e.g., "Form 3")
        new_stream,
        promotion_status,
        student_id
      ]);
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        message: `Successfully ${promotion_status} ${student.first_name} ${student.last_name} from ${student.current_class} ${student.stream || ''} to ${new_class_name} ${new_stream || ''}`,
        data: {
          student_id,
          student_name: `${student.first_name} ${student.last_name}`,
          admission_number: student.admission_number,
          from_class: `${student.current_class} ${student.stream || ''}`,
          to_class: `${new_class_name} ${new_stream || ''}`,
          promotion_status,
          promoted_by: req.user.id,
          promoted_at: new Date().toISOString()
        }
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error promoting student:', error);
      res.status(500).json({ 
        success: false,
        message: 'Server error while promoting student',
        error: error.message 
      });
    } finally {
      client.release();
    }
  });
  
// POST /bulk-promote - bulk promotion
router.post('/bulk-promote', authorizeRoles('admin', 'teacher'), async (req, res) => {
    const client = await pool.connect();
    
    try {
      await client.query('BEGIN');
      
      const {
        current_class_name, // This is the current level (e.g., "Form 2")
        current_stream,
        new_class_name, // This is the new level (e.g., "Form 3")
        new_stream,
        student_ids // Optional: specific students to promote
      } = req.body;
      
      // Validate required fields
      if (!current_class_name || !current_stream || !new_class_name) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields',
          required: ['current_class_name', 'current_stream', 'new_class_name']
        });
      }
      
      // Get students to promote
      let studentsQuery;
      let queryParams;
      
      if (student_ids && Array.isArray(student_ids) && student_ids.length > 0) {
        // Promote specific students
        const placeholders = student_ids.map((_, index) => `$${index + 3}`).join(',');
        studentsQuery = `
          SELECT id, admission_number, first_name, last_name, current_class, stream
          FROM students 
          WHERE current_class = $1 
          AND stream = $2 
          AND status = 'active'
          AND id IN (${placeholders})
          ORDER BY last_name, first_name
        `;
        queryParams = [current_class_name, current_stream, ...student_ids];
      } else {
        // Promote entire class
        studentsQuery = `
          SELECT id, admission_number, first_name, last_name, current_class, stream
          FROM students 
          WHERE current_class = $1 
          AND stream = $2 
          AND status = 'active'
          ORDER BY last_name, first_name
        `;
        queryParams = [current_class_name, current_stream];
      }
      
      const studentsResult = await client.query(studentsQuery, queryParams);
      
      if (studentsResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: `No active students found in ${current_class_name} ${current_stream}`
        });
      }
      
      const students = studentsResult.rows;
      
      // Get current academic session
      const sessionQuery = `
        SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1
      `;
      const sessionResult = await client.query(sessionQuery);
      const currentSessionId = sessionResult.rows[0].id;
      
      let promotedCount = 0;
      let errors = [];
      
      // Promote students individually with proper level handling
      for (const student of students) {
        try {
          // Archive current class in history
          const historyQuery = `
            INSERT INTO student_class_history (
              student_id,
              academic_session_id,
              class_id,
              class_name,
              stream,
              promotion_status,
              promoted_on,
              promoted_by,
              remarks
            ) VALUES (
              $1,
              $2,
              (SELECT id FROM classes WHERE level = $3 AND academic_session_id = $2 LIMIT 1),
              $3,
              $4,
              'promoted',
              CURRENT_DATE,
              $5,
              $6
            )
          `;
          
          await client.query(historyQuery, [
            student.id,
            currentSessionId,
            student.current_class,
            student.stream,
            req.user.id,
            `Bulk promotion from ${current_class_name} ${current_stream} to ${new_class_name} ${new_stream || ''}`
          ]);
          
          // Update student's current class to the new level
          const updateQuery = `
            UPDATE students 
            SET 
              current_class = $1,
              stream = $2,
              updated_at = NOW()
            WHERE id = $3
          `;
          
          await client.query(updateQuery, [
            new_class_name, // This is the level (e.g., "Form 3")
            new_stream,
            student.id
          ]);
          
          promotedCount++;
        } catch (error) {
          errors.push(`Error promoting ${student.first_name} ${student.last_name}: ${error.message}`);
        }
      }
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        message: `Successfully promoted ${promotedCount} students from ${current_class_name} ${current_stream} to ${new_class_name} ${new_stream || ''}`,
        data: {
          promoted_count: promotedCount,
          total_students: students.length,
          from_class: `${current_class_name} ${current_stream}`,
          to_class: `${new_class_name} ${new_stream || ''}`,
          promoted_by: req.user.id,
          promoted_at: new Date().toISOString(),
          students: students.map(s => ({
            id: s.id,
            name: `${s.first_name} ${s.last_name}`,
            admission_number: s.admission_number
          })),
          errors: errors.length > 0 ? errors : undefined
        }
      });
      
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Error in bulk promotion:', error);
      res.status(500).json({ 
        success: false,
        message: 'Server error during bulk promotion',
        error: error.message 
      });
    } finally {
      client.release();
    }
  });

// GET /promotion-history/:student_id - get student's promotion history
router.get('/promotion-history/:student_id', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    const { student_id } = req.params;
    
    const query = `
      SELECT * FROM get_student_progression($1)
    `;
    
    const result = await pool.query(query, [student_id]);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching promotion history:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching promotion history',
      error: error.message 
    });
  }
});

// GET /promotion-statistics - get promotion statistics
router.get('/promotion-statistics', authorizeRoles('admin', 'teacher'), async (req, res) => {
  try {
    const { academic_session_id } = req.query;
    
    let query = `
      SELECT 
        academic_session_id,
        year,
        term,
        from_class,
        promotion_status,
        student_count
      FROM promotion_statistics
    `;
    
    const queryParams = [];
    
    if (academic_session_id) {
      queryParams.push(academic_session_id);
      query += ` WHERE academic_session_id = $${queryParams.length}`;
    }
    
    query += ` ORDER BY year DESC, term DESC, from_class`;
    
    const result = await pool.query(query, queryParams);
    
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching promotion statistics:', error);
    res.status(500).json({ 
      success: false,
      message: 'Server error while fetching promotion statistics',
      error: error.message 
    });
  }
});

// POST /validate-promotion - validate promotion before executing
router.post('/validate-promotion', authorizeRoles('admin', 'teacher'), async (req, res) => {
    try {
      const { student_id, new_class_name, new_stream } = req.body;
      
      if (!student_id || !new_class_name) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields',
          required: ['student_id', 'new_class_name']
        });
      }
      
      // Check if student exists
      const studentQuery = `
        SELECT id, first_name, last_name, current_class, stream, curriculum_type, status
        FROM students 
        WHERE id = $1
      `;
      const studentResult = await pool.query(studentQuery, [student_id]);
      
      if (studentResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Student not found'
        });
      }
      
      const student = studentResult.rows[0];
      
      if (student.status !== 'active') {
        return res.status(400).json({
          success: false,
          message: 'Student is not active'
        });
      }
      
      // Check if target class level exists
      const classQuery = `
        SELECT level, curriculum_type FROM classes 
        WHERE level = $1 
        LIMIT 1
      `;
      const classResult = await pool.query(classQuery, [new_class_name]);
      
      if (classResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Target class level not found'
        });
      }
      
      const targetClass = classResult.rows[0];
      
      // Validation warnings/info
      const warnings = [];
      
      if (student.curriculum_type !== targetClass.curriculum_type) {
        warnings.push(`Curriculum type mismatch: Student is in ${student.curriculum_type}, target class is ${targetClass.curriculum_type}`);
      }
      
      if (student.current_class === new_class_name && student.stream === new_stream) {
        warnings.push('Student is already in the target class and stream');
      }
      
      res.json({
        success: true,
        message: 'Promotion validation successful',
        data: {
          student: {
            id: student.id,
            name: `${student.first_name} ${student.last_name}`,
            current_class: `${student.current_class} ${student.stream || ''}`,
            curriculum_type: student.curriculum_type
          },
          target_class: {
            level: new_class_name,
            stream: new_stream,
            curriculum_type: targetClass.curriculum_type
          },
          warnings: warnings.length > 0 ? warnings : undefined
        }
      });
      
    } catch (error) {
      console.error('Error validating promotion:', error);
      res.status(500).json({ 
        success: false,
        message: 'Server error while validating promotion',
        error: error.message 
      });
    }
  });

export default router;