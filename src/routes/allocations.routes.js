
import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// Get all allocations (teacher-subject assignments)
router.get(
  '/allocations',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { academicSessionId, classId, teacherId, subjectId } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (academicSessionId) {
        queryParams.push(academicSessionId);
        whereClause += `ts.academic_session_id = $${queryParams.length}`;
      }
      
      if (classId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(classId);
        whereClause += `ts.class_id = $${queryParams.length}`;
      }
      
      if (teacherId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(teacherId);
        whereClause += `ts.teacher_id = $${queryParams.length}`;
      }
      
      if (subjectId) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(subjectId);
        whereClause += `ts.subject_id = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get teacher-subject assignments with joined data
      const query = `
        SELECT 
          ts.id,
          ts.teacher_id,
          CONCAT(t.first_name, ' ', t.last_name) AS teacher_name,
          ts.subject_id,
          s.name AS subject_name,
          s.code AS subject_code,
          ts.class_id,
          c.name AS class_name,
          ts.academic_session_id,
          CONCAT(a.year, ' Term ', a.term) AS session_name,
          a.is_current,
          'active' AS status,
          ts.created_at
        FROM 
          teacher_subjects ts
        JOIN 
          teachers t ON ts.teacher_id = t.id
        JOIN 
          subjects s ON ts.subject_id = s.id
        JOIN 
          classes c ON ts.class_id = c.id
        JOIN 
          academic_sessions a ON ts.academic_session_id = a.id
        ${whereClause}
        ORDER BY 
          c.name, s.name, t.last_name
      `;
      
      const result = await pool.query(query, queryParams);
      
      // Calculate weekly hours from timetable for each allocation
      for (const allocation of result.rows) {
        // Query to count hours in the timetable for this allocation
        const hoursQuery = `
          SELECT 
            COUNT(*) AS lesson_count,
            COALESCE(SUM(EXTRACT(EPOCH FROM (end_time - start_time)) / 3600), 0) AS total_hours
          FROM 
            timetable 
          WHERE 
            teacher_id = $1 
            AND subject_id = $2 
            AND class_id = $3 
            AND academic_session_id = $4
        `;
        
        const hoursResult = await pool.query(hoursQuery, [
          allocation.teacher_id, 
          allocation.subject_id, 
          allocation.class_id, 
          allocation.academic_session_id
        ]);
        
        allocation.lesson_count = parseInt(hoursResult.rows[0].lesson_count);
        allocation.total_hours = parseFloat(hoursResult.rows[0].total_hours).toFixed(1);
      }
      
      return res.status(200).json({
        success: true,
        message: 'Allocations fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching allocations:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching allocations',
        error: error.message
      });
    }
  }
);

// Create a new allocation (teacher-subject assignment)
router.post(
  '/allocations',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { teacher_id, subject_id, class_id, academic_session_id } = req.body;
      console.log("route reached", req.body)
      // Validate required fields
      if (!teacher_id || !subject_id || !class_id || !academic_session_id) {
        console.log("Error")
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }
      
      // Check if the allocation already exists
      const checkQuery = `
        SELECT id FROM teacher_subjects
        WHERE teacher_id = $1 AND subject_id = $2 AND class_id = $3 AND academic_session_id = $4
      `;
      
      const checkResult = await pool.query(checkQuery, [teacher_id, subject_id, class_id, academic_session_id]);
      console.log(checkResult.rows)
      if (checkResult.rows.length > 0) {
        console.log("Error 1")
        return res.status(409).json({
          success: false,
          message: 'This allocation already exists'
        });
      }
      
      // Check teacher's specialization
      const teacherQuery = `
        SELECT subject_specialization FROM teachers WHERE id = $1
      `;
      
      const teacherResult = await pool.query(teacherQuery, [teacher_id]);
      console.log(teacherResult.rows)
      if (teacherResult.rows.length === 0) {
        console.log("Error 2")
        return res.status(404).json({
          success: false,
          message: 'Teacher not found'
        });
      }
      
      // Get subject information
      const subjectQuery = `
        SELECT name, code FROM subjects WHERE id = $1
      `;
      
      const subjectResult = await pool.query(subjectQuery, [subject_id]);
      console.log(subjectResult.rows)
      if (subjectResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Subject not found'
        });
      }
      
      // Check if subject is in teacher's specialization (if specialization is set)
      const teacherSpecialization = teacherResult.rows[0].subject_specialization;
      const subjectName = subjectResult.rows[0].name;
      const subjectCode = subjectResult.rows[0].code;
      
      if (teacherSpecialization && teacherSpecialization.length > 0) {
        const hasSpecialization = teacherSpecialization.some(spec => 
          spec === subjectName || spec === subjectCode
        );
        
        if (!hasSpecialization) {
          // Continue but with a warning
          console.warn(`Teacher ID ${teacher_id} is assigned to subject ${subjectName} which is not in their specialization`);
        }
      }
      
      // Insert the new allocation
      const insertQuery = `
        INSERT INTO teacher_subjects (teacher_id, subject_id, class_id, academic_session_id, created_at)
        VALUES ($1, $2, $3, $4, NOW())
        RETURNING id
      `;
      
      const result = await pool.query(insertQuery, [teacher_id, subject_id, class_id, academic_session_id]);
      
      return res.status(201).json({
        success: true,
        message: 'Allocation created successfully',
        data: {
          id: result.rows[0].id,
          teacher_id,
          subject_id,
          class_id,
          academic_session_id
        }
      });
    } catch (error) {
      console.error('Error creating allocation:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating the allocation',
        error: error.message
      });
    }
  }
);

// Update an allocation
router.put(
  '/allocations/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { teacher_id, subject_id, class_id, academic_session_id } = req.body;
      
      // Validate required fields
      if (!teacher_id || !subject_id || !class_id || !academic_session_id) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }
      
      // Check if the allocation already exists with these values (but different ID)
      const checkQuery = `
        SELECT id FROM teacher_subjects
        WHERE teacher_id = $1 AND subject_id = $2 AND class_id = $3 AND academic_session_id = $4 AND id != $5
      `;
      
      const checkResult = await pool.query(checkQuery, [teacher_id, subject_id, class_id, academic_session_id, id]);
      
      if (checkResult.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'This allocation already exists'
        });
      }
      
      // Check if the original allocation exists
      const originalQuery = `
        SELECT * FROM teacher_subjects WHERE id = $1
      `;
      
      const originalResult = await pool.query(originalQuery, [id]);
      
      if (originalResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Allocation not found'
        });
      }
      
      // Update the allocation
      const updateQuery = `
        UPDATE teacher_subjects
        SET teacher_id = $1, subject_id = $2, class_id = $3, academic_session_id = $4
        WHERE id = $5
        RETURNING id
      `;
      
      const result = await pool.query(updateQuery, [teacher_id, subject_id, class_id, academic_session_id, id]);
      
      return res.status(200).json({
        success: true,
        message: 'Allocation updated successfully',
        data: {
          id: result.rows[0].id,
          teacher_id,
          subject_id,
          class_id,
          academic_session_id
        }
      });
    } catch (error) {
      console.error('Error updating allocation:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating the allocation',
        error: error.message
      });
    }
  }
);

// Delete an allocation
router.delete(
  '/allocations/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Get allocation details before deletion
      const allocationQuery = `
        SELECT * FROM teacher_subjects WHERE id = $1
      `;
      
      const allocationResult = await pool.query(allocationQuery, [id]);
      
      if (allocationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Allocation not found'
        });
      }
      
      const allocation = allocationResult.rows[0];
      
      // Check if there are timetable entries for this allocation
      const timetableQuery = `
        SELECT COUNT(*) FROM timetable
        WHERE teacher_id = $1 AND subject_id = $2 AND class_id = $3 AND academic_session_id = $4
      `;
      
      const timetableResult = await pool.query(timetableQuery, [
        allocation.teacher_id,
        allocation.subject_id,
        allocation.class_id,
        allocation.academic_session_id
      ]);
      
      const timetableCount = parseInt(timetableResult.rows[0].count);
      
      // Start a transaction to handle deletion of related timetable entries
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // First delete related timetable entries
        if (timetableCount > 0) {
          const deleteTimetableQuery = `
            DELETE FROM timetable
            WHERE teacher_id = $1 AND subject_id = $2 AND class_id = $3 AND academic_session_id = $4
          `;
          
          await client.query(deleteTimetableQuery, [
            allocation.teacher_id,
            allocation.subject_id,
            allocation.class_id,
            allocation.academic_session_id
          ]);
        }
        
        // Then delete the allocation itself
        const deleteQuery = `
          DELETE FROM teacher_subjects
          WHERE id = $1
          RETURNING id
        `;
        
        const result = await client.query(deleteQuery, [id]);
        
        // Commit the transaction
        await client.query('COMMIT');
        
        return res.status(200).json({
          success: true,
          message: `Allocation deleted successfully. ${timetableCount} related timetable entries were also removed.`,
          data: {
            id: result.rows[0].id,
            timetableEntriesRemoved: timetableCount
          }
        });
      } catch (error) {
        // Rollback transaction in case of error
        await client.query('ROLLBACK');
        throw error;
      } finally {
        // Release the client back to the pool
        client.release();
      }
    } catch (error) {
      console.error('Error deleting allocation:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while deleting the allocation',
        error: error.message
      });
    }
  }
);

export default router