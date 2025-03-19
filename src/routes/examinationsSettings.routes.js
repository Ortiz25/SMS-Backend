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

// IMPORTANT: Put static path routes BEFORE parameter routes
// GET all exam types
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

// GET examination by ID - MOVED AFTER static path routes
router.get(
  '/:id',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Ensure id is a valid integer
      const examId = parseInt(id);
      if (isNaN(examId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid examination ID. Must be a number.'
        });
      }
      
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
      
      const result = await pool.query(query, [examId]);
      
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
      
      // Parse numeric values
      const parsedExamTypeId = parseInt(examTypeId);
      const parsedAcademicSessionId = parseInt(academicSessionId);
      
      // Validate input types
      if (isNaN(parsedExamTypeId) || isNaN(parsedAcademicSessionId)) {
        return res.status(400).json({
          success: false,
          message: 'Exam type ID and academic session ID must be valid numbers'
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
      
      // Check if academic session exists
      const sessionCheck = await client.query(
        'SELECT id FROM academic_sessions WHERE id = $1',
        [parsedAcademicSessionId]
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
        [parsedExamTypeId]
      );
      
      if (examTypeCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Exam type not found'
        });
      }
      
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
        parsedExamTypeId, 
        parsedAcademicSessionId, 
        startDate, 
        endDate, 
        status
      ]);
      
      // Get complete exam information with joins for the response
      const newExamId = insertResult.rows[0].id;
      const detailQuery = `
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
      
      const detailResult = await client.query(detailQuery, [newExamId]);
      
      return res.status(201).json({
        success: true,
        message: 'Examination created successfully',
        data: detailResult.rows[0]
      });
    } catch (error) {
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

// PATCH update examination status
router.patch(
  '/:id/status',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { status } = req.body;
      
      // Ensure id is a valid integer
      const examId = parseInt(id);
      if (isNaN(examId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid examination ID. Must be a number.'
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
      
      const result = await pool.query(updateQuery, [status, examId]);
      
      // Check if examination was found
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Examination not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Examination status updated successfully',
        data: result.rows[0]
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

export default router;