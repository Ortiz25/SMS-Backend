import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// GET all examinations with filtering
router.get(
  '/',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { academicSessionId, examTypeId, status, search } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (academicSessionId && !isNaN(parseInt(academicSessionId))) {
        queryParams.push(parseInt(academicSessionId));
        whereClause += `e.academic_session_id = $${queryParams.length}`;
      }
      
      if (examTypeId && !isNaN(parseInt(examTypeId))) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(parseInt(examTypeId));
        whereClause += `e.exam_type_id = $${queryParams.length}`;
      }
      
      if (status) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(status);
        whereClause += `e.status = $${queryParams.length}`;
      }
      
      if (search) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(`%${search}%`);
        whereClause += `e.name ILIKE $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get examinations with exam type and academic session info
      const query = `
        SELECT 
          e.id,
          e.name,
          e.exam_type_id,
          et.name AS exam_type_name,
          et.curriculum_type,
          et.category,
          et.is_national_exam,
          e.academic_session_id,
          a.year,
          a.term,
          e.start_date,
          e.end_date,
          e.status,
          e.created_at,
          e.updated_at
        FROM 
          examinations e
        JOIN 
          exam_types et ON e.exam_type_id = et.id
        JOIN 
          academic_sessions a ON e.academic_session_id = a.id
        ${whereClause}
        ORDER BY 
          a.year DESC, a.term DESC, e.start_date DESC
      `;
      
      const result = await pool.query(query, queryParams);
      
      return res.status(200).json({
        success: true,
        message: 'Examinations fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching examinations:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching examinations',
        error: error.message
      });
    }
  }
);

router.get(
  '/exam-types',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { curriculumType } = req.query;
      
      let query = `
        SELECT 
          id, name, curriculum_type, category, weight_percentage, is_national_exam, grading_system_id
        FROM 
          exam_types
      `;
      
      const queryParams = [];
      
      // Filter by curriculum type if provided
      if (curriculumType) {
        query += ` WHERE curriculum_type = $1`;
        queryParams.push(curriculumType);
      }
      
      query += ` ORDER BY curriculum_type, name`;
      
      const result = await pool.query(query, queryParams);
      
      return res.status(200).json({
        success: true,
        message: 'Exam types fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching exam types:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching exam types',
        error: error.message
      });
    }
  }
);

// GET academic sessions (helper endpoint)
router.get(
  '/academic-sessions',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const query = `
        SELECT 
          id, year, term, start_date, end_date, is_current, status
        FROM 
          academic_sessions
        ORDER BY 
          year DESC, term ASC
      `;
      
      const result = await pool.query(query);
      
      return res.status(200).json({
        success: true,
        message: 'Academic sessions fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching academic sessions:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching academic sessions',
        error: error.message
      });
    }
  }
);



// GET examination by ID
router.get(
  '/:id',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Query to get examination with detailed information
      const query = `
        SELECT 
          e.*,
          et.name AS exam_type_name,
          et.curriculum_type,
          et.category,
          et.is_national_exam,
          a.year,
          a.term
        FROM 
          examinations e
        JOIN 
          exam_types et ON e.exam_type_id = et.id
        JOIN 
          academic_sessions a ON e.academic_session_id = a.id
        WHERE 
          e.id = $1
      `;
      
      const result = await pool.query(query, [id]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Examination not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Examination fetched successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching examination:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching examination',
        error: error.message
      });
    }
  }
);

// POST create new examination
router.post(
  '/',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { name, examTypeId, academicSessionId, startDate, endDate, status } = req.body;
      
      // Validate dates
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (end < start) {
        return res.status(400).json({
          success: false,
          message: 'End date cannot be before start date'
        });
      }
      
      // Validate status
      const validStatuses = ['scheduled', 'ongoing', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status. Must be one of: scheduled, ongoing, completed, cancelled'
        });
      }
      
      // Check if academic session exists
      const sessionCheck = await client.query(
        'SELECT id FROM academic_sessions WHERE id = $1',
        [academicSessionId]
      );
      
      if (sessionCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Academic session not found'
        });
      }
      
      // Check if exam type exists
      const examTypeCheck = await client.query(
        'SELECT id FROM exam_types WHERE id = $1',
        [examTypeId]
      );
      
      if (examTypeCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Exam type not found'
        });
      }
      
      // Begin transaction
      await client.query('BEGIN');
      
      // Insert new examination
      const insertQuery = `
        INSERT INTO examinations 
          (name, exam_type_id, academic_session_id, start_date, end_date, status)
        VALUES 
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;
      
      const insertResult = await client.query(insertQuery, [
        name,
        examTypeId,
        academicSessionId,
        startDate,
        endDate,
        status
      ]);
      
      // Get exam type and academic session info for response
      const detailsQuery = `
        SELECT 
          et.name AS exam_type_name,
          et.curriculum_type,
          et.category,
          et.is_national_exam,
          a.year,
          a.term
        FROM 
          exam_types et, academic_sessions a
        WHERE 
          et.id = $1 AND a.id = $2
      `;
      
      const detailsResult = await client.query(detailsQuery, [examTypeId, academicSessionId]);
      
      // Commit transaction
      await client.query('COMMIT');
      
      // Combine results for response
      const responseData = {
        ...insertResult.rows[0],
        exam_type_name: detailsResult.rows[0]?.exam_type_name,
        curriculum_type: detailsResult.rows[0]?.curriculum_type,
        category: detailsResult.rows[0]?.category,
        is_national_exam: detailsResult.rows[0]?.is_national_exam,
        year: detailsResult.rows[0]?.year,
        term: detailsResult.rows[0]?.term
      };
      
      return res.status(201).json({
        success: true,
        message: 'Examination created successfully',
        data: responseData
      });
    } catch (error) {
      // Rollback in case of error
      await client.query('ROLLBACK');
      
      console.error('Error creating examination:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating examination',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// PUT update examination
router.put(
  '/:id',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      const { name, examTypeId, academicSessionId, startDate, endDate, status } = req.body;
      
      // Check if examination exists and is not completed or cancelled
      const examCheck = await client.query(
        'SELECT status FROM examinations WHERE id = $1',
        [id]
      );
      
      if (examCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Examination not found'
        });
      }
      
      const currentStatus = examCheck.rows[0].status;
      
      // Prevent updates to completed or cancelled examinations
      if (currentStatus === 'completed' || currentStatus === 'cancelled') {
        return res.status(403).json({
          success: false,
          message: `Cannot update a ${currentStatus} examination`
        });
      }
      
      // Validate dates
      const start = new Date(startDate);
      const end = new Date(endDate);
      
      if (end < start) {
        return res.status(400).json({
          success: false,
          message: 'End date cannot be before start date'
        });
      }
      
      // Validate status
      const validStatuses = ['scheduled', 'ongoing', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status. Must be one of: scheduled, ongoing, completed, cancelled'
        });
      }
      
      // Begin transaction
      await client.query('BEGIN');
      
      // Update examination
      const updateQuery = `
        UPDATE examinations
        SET 
          name = $1,
          exam_type_id = $2,
          academic_session_id = $3,
          start_date = $4,
          end_date = $5,
          status = $6,
          updated_at = NOW()
        WHERE 
          id = $7
        RETURNING *
      `;
      
      const updateResult = await client.query(updateQuery, [
        name,
        examTypeId,
        academicSessionId,
        startDate,
        endDate,
        status,
        id
      ]);
      
      // Get exam type and academic session info for response
      const detailsQuery = `
        SELECT 
          et.name AS exam_type_name,
          et.curriculum_type,
          et.category,
          et.is_national_exam,
          a.year,
          a.term
        FROM 
          exam_types et, academic_sessions a
        WHERE 
          et.id = $1 AND a.id = $2
      `;
      
      const detailsResult = await client.query(detailsQuery, [examTypeId, academicSessionId]);
      
      // Commit transaction
      await client.query('COMMIT');
      
      // Combine results for response
      const responseData = {
        ...updateResult.rows[0],
        exam_type_name: detailsResult.rows[0]?.exam_type_name,
        curriculum_type: detailsResult.rows[0]?.curriculum_type,
        category: detailsResult.rows[0]?.category,
        is_national_exam: detailsResult.rows[0]?.is_national_exam,
        year: detailsResult.rows[0]?.year,
        term: detailsResult.rows[0]?.term
      };
      
      return res.status(200).json({
        success: true,
        message: 'Examination updated successfully',
        data: responseData
      });
    } catch (error) {
      // Rollback in case of error
      await client.query('ROLLBACK');
      
      console.error('Error updating examination:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating examination',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// PATCH update examination status
router.patch(
  '/:id/status',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      
      // Validate status
      const validStatuses = ['scheduled', 'ongoing', 'completed', 'cancelled'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid status. Must be one of: scheduled, ongoing, completed, cancelled'
        });
      }
      
      // Check if examination exists
      const examCheck = await pool.query(
        'SELECT status FROM examinations WHERE id = $1',
        [id]
      );
      
      if (examCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Examination not found'
        });
      }
      
      const currentStatus = examCheck.rows[0].status;
      
      // Validate status transitions
      const invalidTransitions = {
        'completed': ['scheduled', 'ongoing'],
        'cancelled': ['ongoing', 'completed']
      };
      
      if (invalidTransitions[currentStatus] && invalidTransitions[currentStatus].includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot change status from ${currentStatus} to ${status}`
        });
      }
      
      // Update examination status
      const updateQuery = `
        UPDATE examinations
        SET 
          status = $1,
          updated_at = NOW()
        WHERE 
          id = $2
        RETURNING *
      `;
      
      const updateResult = await pool.query(updateQuery, [status, id]);
      
      return res.status(200).json({
        success: true,
        message: 'Examination status updated successfully',
        data: updateResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating examination status:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating examination status',
        error: error.message
      });
    }
  }
);

// GET exam schedules for a specific examination
router.get(
  '/:id/schedules',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Check if examination exists
      const examCheck = await pool.query(
        'SELECT id FROM examinations WHERE id = $1',
        [id]
      );
      
      if (examCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Examination not found'
        });
      }
      
      // Query to get exam schedules with subject, class, and supervisor info
      const query = `
        SELECT 
          es.id,
          es.examination_id,
          es.subject_id,
          s.name AS subject_name,
          s.code AS subject_code,
          es.class_id,
          c.name AS class_name,
          c.level,
          c.stream,
          es.exam_date,
          es.start_time,
          es.end_time,
          es.venue,
          es.supervisor_id,
          CONCAT(t.first_name, ' ', t.last_name) AS supervisor_name,
          es.total_marks,
          es.passing_marks,
          es.status,
          es.created_at,
          es.updated_at
        FROM 
          exam_schedules es
        JOIN 
          subjects s ON es.subject_id = s.id
        JOIN 
          classes c ON es.class_id = c.id
        LEFT JOIN 
          teachers t ON es.supervisor_id = t.id
        WHERE 
          es.examination_id = $1
        ORDER BY 
          es.exam_date, es.start_time, s.name
      `;
      
      const result = await pool.query(query, [id]);
      
      return res.status(200).json({
        success: true,
        message: 'Exam schedules fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching exam schedules:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching exam schedules',
        error: error.message
      });
    }
  }
);

// GET reference data for examinations
router.get(
  '/reference-data',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      // Get current academic session
      const currentSessionQuery = `
        SELECT 
          id, year, term, is_current, status
        FROM 
          academic_sessions
        WHERE 
          is_current = true
        LIMIT 1
      `;
      
      const currentSessionResult = await pool.query(currentSessionQuery);
      
      // Get all academic sessions
      const academicSessionsQuery = `
        SELECT 
          id, year, term, is_current, status
        FROM 
          academic_sessions
        ORDER BY 
          year DESC, term DESC
      `;
      
      const academicSessionsResult = await pool.query(academicSessionsQuery);
      
      // Get all exam types
      const examTypesQuery = `
        SELECT 
          id, name, curriculum_type, category, is_national_exam, grading_system_id
        FROM 
          exam_types
        ORDER BY 
          curriculum_type, category, name
      `;
      
      const examTypesResult = await pool.query(examTypesQuery);
      
      return res.status(200).json({
        success: true,
        message: 'Reference data fetched successfully',
        data: {
          currentSession: currentSessionResult.rows[0] || null,
          academicSessions: academicSessionsResult.rows,
          examTypes: examTypesResult.rows
        }
      });
    } catch (error) {
      console.error('Error fetching reference data:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching reference data',
        error: error.message
      });
    }
  }
);

export default router;