import express from 'express';
import pool from '../config/database.js';
import { authenticateToken, authorizeRoles } from '../middleware/auth.js';


const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);


// Get all academic sessions
router.get(
  '/academic-sessions',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { year, term, isCurrent } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (year) {
        queryParams.push(year);
        whereClause += `year = $${queryParams.length}`;
      }
      
      if (term) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(term);
        whereClause += `term = $${queryParams.length}`;
      }
      
      if (isCurrent !== undefined) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(isCurrent === 'true');
        whereClause += `is_current = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get academic sessions
      const query = `
        SELECT 
          id,
          year,
          term,
          start_date,
          end_date,
          is_current,
          status
        FROM 
          academic_sessions
        ${whereClause}
        ORDER BY 
          year DESC, term ASC
      `;
      
      const result = await pool.query(query, queryParams);
      
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

// Get current academic session
router.get(
  '/academic-sessions/current',
  authorizeRoles('admin', 'teacher', 'staff', 'student', 'parent'),
  async (req, res) => {
    try {
      const query = `
        SELECT 
          id,
          year,
          term,
          start_date,
          end_date,
          status
        FROM 
          academic_sessions
        WHERE 
          is_current = true
        LIMIT 1
      `;
      
      const result = await pool.query(query);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No current academic session found'
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Current academic session fetched successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching current academic session:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching the current academic session',
        error: error.message
      });
    }
  }
);

// Get specific academic session by ID
router.get(
  '/academic-sessions/:id',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      const query = `
        SELECT 
          id,
          year,
          term,
          start_date,
          end_date,
          is_current,
          status
        FROM 
          academic_sessions
        WHERE 
          id = $1
      `;
      
      const result = await pool.query(query, [id]);
      
      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Academic session not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Academic session fetched successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching academic session:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching the academic session',
        error: error.message
      });
    }
  }
);

// Create a new academic session
router.post(
  '/academic-sessions',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { year, term, start_date, end_date, is_current, status } = req.body;
      
      // Validate required fields
      if (!year || !term || !start_date || !end_date) {
        return res.status(400).json({
          success: false,
          message: 'Missing required fields'
        });
      }
      
      // Validate term is 1, 2, or 3
      if (![1, 2, 3].includes(parseInt(term))) {
        return res.status(400).json({
          success: false,
          message: 'Term must be 1, 2, or 3'
        });
      }
      
      // Check for duplicate year and term
      const checkQuery = `
        SELECT id FROM academic_sessions
        WHERE year = $1 AND term = $2
      `;
      
      const checkResult = await pool.query(checkQuery, [year, term]);
      
      if (checkResult.rows.length > 0) {
        return res.status(409).json({
          success: false,
          message: `Academic session for Year ${year}, Term ${term} already exists`
        });
      }
      
      // Start transaction
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // If setting as current session, update all other sessions first
        if (is_current) {
          await client.query(`
            UPDATE academic_sessions
            SET is_current = false
            WHERE is_current = true
          `);
        }
        
        // Insert the new academic session
        const insertQuery = `
          INSERT INTO academic_sessions (
            year, 
            term, 
            start_date, 
            end_date, 
            is_current, 
            status,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
          RETURNING id, year, term, start_date, end_date, is_current, status
        `;
        
        const insertResult = await client.query(insertQuery, [
          year,
          term,
          start_date,
          end_date,
          is_current || false,
          status || 'active'
        ]);
        
        // Commit transaction
        await client.query('COMMIT');
        
        return res.status(201).json({
          success: true,
          message: 'Academic session created successfully',
          data: insertResult.rows[0]
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
      console.error('Error creating academic session:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating the academic session',
        error: error.message
      });
    }
  }
);

// Update an academic session
router.put(
  '/academic-sessions/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { year, term, start_date, end_date, is_current, status } = req.body;
      
      // Check if session exists
      const checkQuery = `
        SELECT * FROM academic_sessions WHERE id = $1
      `;
      
      const checkResult = await pool.query(checkQuery, [id]);
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Academic session not found'
        });
      }
      
      // Check for duplicate year and term (excluding current record)
      if (year && term) {
        const dupQuery = `
          SELECT id FROM academic_sessions
          WHERE year = $1 AND term = $2 AND id != $3
        `;
        
        const dupResult = await pool.query(dupQuery, [year, term, id]);
        
        if (dupResult.rows.length > 0) {
          return res.status(409).json({
            success: false,
            message: `Another academic session for Year ${year}, Term ${term} already exists`
          });
        }
      }
      
      // Build update query dynamically based on provided fields
      const updateFields = [];
      const queryParams = [];
      let paramCounter = 1;
      
      if (year !== undefined) {
        updateFields.push(`year = $${paramCounter++}`);
        queryParams.push(year);
      }
      
      if (term !== undefined) {
        updateFields.push(`term = $${paramCounter++}`);
        queryParams.push(term);
      }
      
      if (start_date !== undefined) {
        updateFields.push(`start_date = $${paramCounter++}`);
        queryParams.push(start_date);
      }
      
      if (end_date !== undefined) {
        updateFields.push(`end_date = $${paramCounter++}`);
        queryParams.push(end_date);
      }
      
      if (status !== undefined) {
        updateFields.push(`status = $${paramCounter++}`);
        queryParams.push(status);
      }
      
      // Always update the updated_at timestamp
      updateFields.push(`updated_at = NOW()`);
      
      // Add ID as the last parameter
      queryParams.push(id);
      
      // Start transaction
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // If setting as current session, update all other sessions first
        if (is_current) {
          await client.query(`
            UPDATE academic_sessions
            SET is_current = false
            WHERE is_current = true AND id != $1
          `, [id]);
          
          // Add is_current to the fields to update
          updateFields.push(`is_current = true`);
        } else if (is_current === false) {
          // Only set to false if explicitly requested and not already the current session
          const currentSession = await client.query(`
            SELECT is_current FROM academic_sessions WHERE id = $1
          `, [id]);
          
          if (currentSession.rows[0].is_current) {
            return res.status(400).json({
              success: false,
              message: 'Cannot set the current academic session to inactive. Set another session as current first.'
            });
          }
          
          updateFields.push(`is_current = false`);
        }
        
        // If no fields to update, return early
        if (updateFields.length === 0) {
          await client.query('COMMIT');
          return res.status(200).json({
            success: true,
            message: 'No changes to apply',
            data: checkResult.rows[0]
          });
        }
        
        // Update the academic session
        const updateQuery = `
          UPDATE academic_sessions
          SET ${updateFields.join(', ')}
          WHERE id = $${paramCounter}
          RETURNING id, year, term, start_date, end_date, is_current, status
        `;
        
        const updateResult = await client.query(updateQuery, queryParams);
        
        // Commit transaction
        await client.query('COMMIT');
        
        return res.status(200).json({
          success: true,
          message: 'Academic session updated successfully',
          data: updateResult.rows[0]
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
      console.error('Error updating academic session:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating the academic session',
        error: error.message
      });
    }
  }
);

// Set current academic session
router.post(
  '/academic-sessions/:id/set-current',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Check if session exists
      const checkQuery = `
        SELECT * FROM academic_sessions WHERE id = $1
      `;
      
      const checkResult = await pool.query(checkQuery, [id]);
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Academic session not found'
        });
      }
      
      // Start transaction
      const client = await pool.connect();
      
      try {
        await client.query('BEGIN');
        
        // First, set all sessions to not current
        await client.query(`
          UPDATE academic_sessions
          SET is_current = false,
              updated_at = NOW()
        `);
        
        // Then, set the specified session as current
        const updateQuery = `
          UPDATE academic_sessions
          SET is_current = true,
              updated_at = NOW()
          WHERE id = $1
          RETURNING id, year, term, is_current
        `;
        
        const updateResult = await client.query(updateQuery, [id]);
        
        // Commit transaction
        await client.query('COMMIT');
        
        return res.status(200).json({
          success: true,
          message: `Academic session Year ${updateResult.rows[0].year}, Term ${updateResult.rows[0].term} is now set as current`,
          data: updateResult.rows[0]
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
      console.error('Error setting current academic session:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while setting the current academic session',
        error: error.message
      });
    }
  }
);

// Delete an academic session
router.delete(
  '/academic-sessions/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Check if session exists and if it's the current session
      const checkQuery = `
        SELECT id, year, term, is_current FROM academic_sessions WHERE id = $1
      `;
      
      const checkResult = await pool.query(checkQuery, [id]);
      
      if (checkResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Academic session not found'
        });
      }
      
      const session = checkResult.rows[0];
      
      // Don't allow deletion of the current session
      if (session.is_current) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete the current academic session. Set another session as current first.'
        });
      }
      
      // Check if session has dependencies
      const dependencyQueries = [
        {
          table: 'classes',
          query: 'SELECT COUNT(*) FROM classes WHERE academic_session_id = $1'
        },
        {
          table: 'timetable',
          query: 'SELECT COUNT(*) FROM timetable WHERE academic_session_id = $1'
        },
        {
          table: 'teacher_subjects',
          query: 'SELECT COUNT(*) FROM teacher_subjects WHERE academic_session_id = $1'
        },
        {
          table: 'student_subjects',
          query: 'SELECT COUNT(*) FROM student_subjects WHERE academic_session_id = $1'
        },
        {
          table: 'examinations',
          query: 'SELECT COUNT(*) FROM examinations WHERE academic_session_id = $1'
        },
        {
          table: 'fee_structure',
          query: 'SELECT COUNT(*) FROM fee_structure WHERE academic_session_id = $1'
        }
      ];
      
      const dependencies = [];
      
      for (const dependency of dependencyQueries) {
        const result = await pool.query(dependency.query, [id]);
        const count = parseInt(result.rows[0].count);
        
        if (count > 0) {
          dependencies.push({
            table: dependency.table,
            count: count
          });
        }
      }
      
      if (dependencies.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete academic session because it is referenced by other records',
          data: {
            dependencies: dependencies
          }
        });
      }
      
      // Delete the academic session
      const deleteQuery = `
        DELETE FROM academic_sessions
        WHERE id = $1
        RETURNING id
      `;
      
      const deleteResult = await pool.query(deleteQuery, [id]);
      
      return res.status(200).json({
        success: true,
        message: `Academic session Year ${session.year}, Term ${session.term} deleted successfully`,
        data: {
          id: deleteResult.rows[0].id
        }
      });
    } catch (error) {
      console.error('Error deleting academic session:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while deleting the academic session',
        error: error.message
      });
    }
  }
);

export default router