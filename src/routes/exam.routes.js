import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// Get exam types
router.get(
  '/exam-types',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { curriculumType, category } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (curriculumType) {
        queryParams.push(curriculumType);
        whereClause += `curriculum_type = $${queryParams.length}`;
      }
      
      if (category) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(category);
        whereClause += `category = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get exam types
      const query = `
        SELECT 
          id,
          name,
          curriculum_type,
          category,
          weight_percentage,
          is_national_exam,
          grading_system_id
        FROM 
          exam_types
        ${whereClause}
        ORDER BY 
          name
      `;
      
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

// Get examinations
router.get(
  '/examinations',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { academicSessionId, examTypeId } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (academicSessionId) {
        queryParams.push(academicSessionId);
        whereClause += `e.academic_session_id = $${queryParams.length}`;
      }
      
      if (examTypeId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(examTypeId);
        whereClause += `e.exam_type_id = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get examinations with related info
      const query = `
        SELECT 
          e.id,
          e.name,
          e.exam_type_id,
          et.name AS exam_type_name,
          et.category AS exam_type_category,
          e.academic_session_id,
          CONCAT(a.year, ' Term ', a.term) AS academic_session_name,
          e.start_date,
          e.end_date,
          e.status
        FROM 
          examinations e
        JOIN 
          exam_types et ON e.exam_type_id = et.id
        JOIN 
          academic_sessions a ON e.academic_session_id = a.id
        ${whereClause}
        ORDER BY 
          e.start_date DESC
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

// Create a new examination
router.post(
  '/examinations',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    try {
      const { name, exam_type_id, academic_session_id, start_date, end_date, status } = req.body;
      
      // Validate required fields
      if (!name || !exam_type_id || !academic_session_id || !start_date || !end_date) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }
      
      // Check if examination already exists with same name and session
      const checkQuery = `
        SELECT id FROM examinations
        WHERE name = $1 AND academic_session_id = $2
      `;
      
      const checkResult = await pool.query(checkQuery, [name, academic_session_id]);
      
      if (checkResult.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'An examination with this name already exists for the selected academic session'
        });
      }
      
      // Insert the new examination
      const insertQuery = `
        INSERT INTO examinations (
          name, 
          exam_type_id, 
          academic_session_id, 
          start_date, 
          end_date, 
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        RETURNING id, name, exam_type_id, academic_session_id, start_date, end_date, status
      `;
      
      const result = await pool.query(insertQuery, [
        name,
        exam_type_id,
        academic_session_id,
        start_date,
        end_date,
        status || 'scheduled'
      ]);
      
      return res.status(201).json({
        success: true,
        message: 'Examination created successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error creating examination:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating the examination',
        error: error.message
      });
    }
  }
);

// Get exam schedules
router.get(
  '/exam-schedules',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { examinationId, academicSessionId, classId, subjectId, examinationName } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (examinationId) {
        queryParams.push(examinationId);
        whereClause += `es.examination_id = $${queryParams.length}`;
      }
      
      if (academicSessionId && !examinationId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(academicSessionId);
        whereClause += `e.academic_session_id = $${queryParams.length}`;
      }
      
      if (classId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(classId);
        whereClause += `es.class_id = $${queryParams.length}`;
      }
      
      if (subjectId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(subjectId);
        whereClause += `es.subject_id = $${queryParams.length}`;
      }
      
      if (examinationName) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(`%${examinationName}%`);
        whereClause += `e.name ILIKE $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get exam schedules with related info
      const query = `
        SELECT 
          es.id,
          es.examination_id,
          e.name AS examination_name,
          e.exam_type_id,
          et.name AS exam_type_name,
          e.academic_session_id,
          es.subject_id,
          s.name AS subject_name,
          s.code AS subject_code,
          es.class_id,
          c.name AS class_name,
          es.exam_date,
          es.start_time,
          es.end_time,
          es.venue,
          es.supervisor_id,
          CONCAT(t.first_name, ' ', t.last_name) AS supervisor_name,
          es.total_marks,
          es.passing_marks,
          es.status
        FROM 
          exam_schedules es
        JOIN 
          examinations e ON es.examination_id = e.id
        JOIN 
          exam_types et ON e.exam_type_id = et.id
        JOIN 
          subjects s ON es.subject_id = s.id
        JOIN 
          classes c ON es.class_id = c.id
        LEFT JOIN 
          teachers t ON es.supervisor_id = t.id
        ${whereClause}
        ORDER BY 
          es.exam_date, es.start_time
      `;
      
      const result = await pool.query(query, queryParams);
      
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

// Create a new exam schedule
router.post(
  '/exam-schedules',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    try {
      const { 
        examination_id, 
        subject_id, 
        class_id, 
        exam_date, 
        start_time, 
        end_time, 
        venue, 
        supervisor_id, 
        total_marks, 
        passing_marks, 
        status 
      } = req.body;
      
      // Validate required fields
      if (!examination_id || !subject_id || !class_id || !exam_date || !start_time || !end_time || !venue) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }
      
      // Check if there's already a schedule for the same examination, subject, and class
      const checkQuery = `
        SELECT id FROM exam_schedules
        WHERE examination_id = $1 AND subject_id = $2 AND class_id = $3
      `;
      
      const checkResult = await pool.query(checkQuery, [examination_id, subject_id, class_id]);
      
      if (checkResult.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'An exam schedule already exists for this examination, subject, and class'
        });
      }
      
      // Check for schedule conflicts (same venue, date, and overlapping time)
      const conflictQuery = `
        SELECT id FROM exam_schedules
        WHERE venue = $1 AND exam_date = $2 
        AND (
          (start_time, end_time) OVERLAPS ($3::time, $4::time)
        )
      `;
      
      const conflictResult = await pool.query(conflictQuery, [venue, exam_date, start_time, end_time]);
      
      if (conflictResult.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'There is a scheduling conflict with another exam at the same venue and time'
        });
      }
      
      // Check for class conflicts (same class, date, and overlapping time)
      const classConflictQuery = `
        SELECT id FROM exam_schedules
        WHERE class_id = $1 AND exam_date = $2 
        AND (
          (start_time, end_time) OVERLAPS ($3::time, $4::time)
        )
      `;
      
      const classConflictResult = await pool.query(classConflictQuery, [class_id, exam_date, start_time, end_time]);
      
      if (classConflictResult.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'This class already has another exam scheduled at the same time'
        });
      }
      
      // Insert the new exam schedule
      const insertQuery = `
        INSERT INTO exam_schedules (
          examination_id,
          subject_id,
          class_id,
          exam_date,
          start_time,
          end_time,
          venue,
          supervisor_id,
          total_marks,
          passing_marks,
          status,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
        RETURNING id
      `;
      
      const result = await pool.query(insertQuery, [
        examination_id,
        subject_id,
        class_id,
        exam_date,
        start_time,
        end_time,
        venue,
        supervisor_id || null,
        total_marks || 100,
        passing_marks || 40,
        status || 'scheduled'
      ]);
      
      // Get the full exam schedule details to return
      const getScheduleQuery = `
        SELECT 
          es.id,
          es.examination_id,
          e.name AS examination_name,
          es.subject_id,
          s.name AS subject_name,
          es.class_id,
          c.name AS class_name,
          es.exam_date,
          es.start_time,
          es.end_time,
          es.venue,
          es.supervisor_id,
          es.status
        FROM 
          exam_schedules es
        JOIN 
          examinations e ON es.examination_id = e.id
        JOIN 
          subjects s ON es.subject_id = s.id
        JOIN 
          classes c ON es.class_id = c.id
        WHERE 
          es.id = $1
      `;
      
      const scheduleResult = await pool.query(getScheduleQuery, [result.rows[0].id]);
      
      return res.status(201).json({
        success: true,
        message: 'Exam schedule created successfully',
        data: scheduleResult.rows[0]
      });
    } catch (error) {
      console.error('Error creating exam schedule:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating the exam schedule',
        error: error.message
      });
    }
  }
);

// Update an exam schedule
router.put(
  '/exam-schedules/:id',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { 
        subject_id, 
        class_id, 
        exam_date, 
        start_time, 
        end_time, 
        venue, 
        supervisor_id, 
        total_marks, 
        passing_marks, 
        status 
      } = req.body;
      
      // Check if the exam schedule exists
      const checkQuery = `
        SELECT * FROM exam_schedules WHERE id = $1
      `;
      
      const checkResult = await pool.query(checkQuery, [id]);
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Exam schedule not found'
        });
      }
      
      const examSchedule = checkResult.rows[0];
      
      // Check for schedule conflicts only if date, time, or venue is changed
      if ((exam_date && exam_date !== examSchedule.exam_date) || 
          (start_time && start_time !== examSchedule.start_time) || 
          (end_time && end_time !== examSchedule.end_time) || 
          (venue && venue !== examSchedule.venue)) {
            
        const newDate = exam_date || examSchedule.exam_date;
        const newStartTime = start_time || examSchedule.start_time;
        const newEndTime = end_time || examSchedule.end_time;
        const newVenue = venue || examSchedule.venue;
        
        // Check for venue conflicts
        const conflictQuery = `
          SELECT id FROM exam_schedules
          WHERE venue = $1 AND exam_date = $2 
          AND (
            (start_time, end_time) OVERLAPS ($3::time, $4::time)
          )
          AND id != $5
        `;
        
        const conflictResult = await pool.query(conflictQuery, [
          newVenue, 
          newDate, 
          newStartTime, 
          newEndTime, 
          id
        ]);
        
        if (conflictResult.rows.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'There is a scheduling conflict with another exam at the same venue and time'
          });
        }
        
        // Check for class conflicts
        const newClassId = class_id || examSchedule.class_id;
        
        const classConflictQuery = `
          SELECT id FROM exam_schedules
          WHERE class_id = $1 AND exam_date = $2 
          AND (
            (start_time, end_time) OVERLAPS ($3::time, $4::time)
          )
          AND id != $5
        `;
        
        const classConflictResult = await pool.query(classConflictQuery, [
          newClassId, 
          newDate, 
          newStartTime, 
          newEndTime, 
          id
        ]);
        
        if (classConflictResult.rows.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'This class already has another exam scheduled at the same time'
          });
        }
      }
      
      // Build update query dynamically based on provided fields
      const updateFields = [];
      const queryParams = [];
      let paramCounter = 1;
      
      if (subject_id !== undefined) {
        updateFields.push(`subject_id = $${paramCounter++}`);
        queryParams.push(subject_id);
      }
      
      if (class_id !== undefined) {
        updateFields.push(`class_id = $${paramCounter++}`);
        queryParams.push(class_id);
      }
      
      if (exam_date !== undefined) {
        updateFields.push(`exam_date = $${paramCounter++}`);
        queryParams.push(exam_date);
      }
      
      if (start_time !== undefined) {
        updateFields.push(`start_time = $${paramCounter++}`);
        queryParams.push(start_time);
      }
      
      if (end_time !== undefined) {
        updateFields.push(`end_time = $${paramCounter++}`);
        queryParams.push(end_time);
      }
      
      if (venue !== undefined) {
        updateFields.push(`venue = $${paramCounter++}`);
        queryParams.push(venue);
      }
      
      if (supervisor_id !== undefined) {
        updateFields.push(`supervisor_id = $${paramCounter++}`);
        queryParams.push(supervisor_id || null);
      }
      
      if (total_marks !== undefined) {
        updateFields.push(`total_marks = $${paramCounter++}`);
        queryParams.push(total_marks);
      }
      
      if (passing_marks !== undefined) {
        updateFields.push(`passing_marks = $${paramCounter++}`);
        queryParams.push(passing_marks);
      }
      
      if (status !== undefined) {
        updateFields.push(`status = $${paramCounter++}`);
        queryParams.push(status);
      }
      
      // Always update the updated_at timestamp
      updateFields.push(`updated_at = NOW()`);
      
      // Add ID as the last parameter
      queryParams.push(id);
      
      // Update the exam schedule
      const updateQuery = `
        UPDATE exam_schedules
        SET ${updateFields.join(', ')}
        WHERE id = $${paramCounter}
        RETURNING id
      `;
      
      const result = await pool.query(updateQuery, queryParams);
      
      // Get the updated exam schedule details
      const getUpdatedScheduleQuery = `
        SELECT 
          es.id,
          es.examination_id,
          e.name AS examination_name,
          es.subject_id,
          s.name AS subject_name,
          es.class_id,
          c.name AS class_name,
          es.exam_date,
          es.start_time,
          es.end_time,
          es.venue,
          es.supervisor_id,
          CONCAT(t.first_name, ' ', t.last_name) AS supervisor_name,
          es.total_marks,
          es.passing_marks,
          es.status
        FROM 
          exam_schedules es
        JOIN 
          examinations e ON es.examination_id = e.id
        JOIN 
          subjects s ON es.subject_id = s.id
        JOIN 
          classes c ON es.class_id = c.id
        LEFT JOIN 
          teachers t ON es.supervisor_id = t.id
        WHERE 
          es.id = $1
      `;
      
      const updatedResult = await pool.query(getUpdatedScheduleQuery, [id]);
      
      return res.status(200).json({
        success: true,
        message: 'Exam schedule updated successfully',
        data: updatedResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating exam schedule:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating the exam schedule',
        error: error.message
      });
    }
  }
);

// Delete an exam schedule
router.delete(
  '/exam-schedules/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Check if the exam schedule exists
      const checkQuery = `
        SELECT es.*, e.name AS examination_name
        FROM exam_schedules es
        JOIN examinations e ON es.examination_id = e.id
        WHERE es.id = $1
      `;
      
      const checkResult = await pool.query(checkQuery, [id]);
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Exam schedule not found'
        });
      }
      
      const examSchedule = checkResult.rows[0];
      
      // Start a transaction to handle deletion of related results
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // First check if there are any results
        const resultsQuery = `
          SELECT COUNT(*) FROM exam_results
          WHERE exam_schedule_id = $1
        `;
        
        const resultsCount = await client.query(resultsQuery, [id]);
        const hasResults = parseInt(resultsCount.rows[0].count) > 0;
        
        let deletedResults = 0;
        
        // Delete related results if they exist
        if (hasResults) {
          const deleteResultsQuery = `
            DELETE FROM exam_results
            WHERE exam_schedule_id = $1
            RETURNING id
          `;
          
          const deleteResultsResult = await client.query(deleteResultsQuery, [id]);
          deletedResults = deleteResultsResult.rowCount;
        }
        
        // Delete the exam schedule
        const deleteQuery = `
          DELETE FROM exam_schedules
          WHERE id = $1
          RETURNING id
        `;
        
        const deleteResult = await client.query(deleteQuery, [id]);
        
        // Commit transaction
        await client.query('COMMIT');
        
        return res.status(200).json({
          success: true,
          message: `Exam schedule deleted successfully. ${deletedResults > 0 ? `${deletedResults} related results were also removed.` : ''}`,
          data: {
            id: deleteResult.rows[0].id,
            examinationName: examSchedule.examination_name,
            resultsDeleted: deletedResults
          }
        });
      } catch (error) {
        // Rollback transaction in case of error
        await client.query('ROLLBACK');
        throw error;
      } finally {
        // Release client back to pool
        client.release();
      }
    } catch (error) {
      console.error('Error deleting exam schedule:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while deleting the exam schedule',
        error: error.message
      });
    }
  }
);

// Get exam results
router.get(
  '/exam-results',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { examScheduleId, studentId, classId } = req.query;
      
      // Ensure at least one filter is provided
      if (!examScheduleId && !studentId && !classId) {
        return res.status(400).json({
          success: false,
          message: 'At least one filter (examScheduleId, studentId, or classId) is required'
        });
      }
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (examScheduleId) {
        queryParams.push(examScheduleId);
        whereClause += `er.exam_schedule_id = $${queryParams.length}`;
      }
      
      if (studentId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(studentId);
        whereClause += `er.student_id = $${queryParams.length}`;
      }
      
      if (classId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(classId);
        whereClause += `es.class_id = $${queryParams.length}`;
      }
      
      // Query to get exam results with related info
      const query = `
        SELECT 
          er.id,
          er.student_id,
          s.admission_number,
          CONCAT(s.first_name, ' ', s.last_name) AS student_name,
          er.exam_schedule_id,
          es.subject_id,
          subj.name AS subject_name,
          es.examination_id,
          e.name AS examination_name,
          es.class_id,
          c.name AS class_name,
          er.marks_obtained,
          er.grade,
          er.points,
          er.is_absent,
          er.created_at,
          er.updated_at
        FROM 
          exam_results er
        JOIN 
          students s ON er.student_id = s.id
        JOIN 
          exam_schedules es ON er.exam_schedule_id = es.id
        JOIN 
          examinations e ON es.examination_id = e.id
        JOIN 
          classes c ON es.class_id = c.id
        JOIN 
          subjects subj ON es.subject_id = subj.id
        WHERE 
          ${whereClause}
        ORDER BY 
          s.admission_number
      `;
      
      const result = await pool.query(query, queryParams);
      
      return res.status(200).json({
        success: true,
        message: 'Exam results fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching exam results:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching exam results',
        error: error.message
      });
    }
  }
);

// Add more routes for exam results entry, updating, and analysis as needed

export default router