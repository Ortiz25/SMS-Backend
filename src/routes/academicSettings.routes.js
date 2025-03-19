import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// GET all academic sessions
router.get(
  '/academic-sessions',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { year, isCurrent } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (year) {
        queryParams.push(year);
        whereClause += `year = $${queryParams.length}`;
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
          status,
          created_at,
          updated_at
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

// POST create new academic session
router.post(
  '/academic-sessions',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { year, term, startDate, endDate, isCurrent, status } = req.body;
      
      // Check if year and term combination already exists
      const checkQuery = 'SELECT id FROM academic_sessions WHERE year = $1 AND term = $2';
      const checkResult = await client.query(checkQuery, [year, term]);
      
      if (checkResult.rowCount > 0) {
        return res.status(400).json({
          success: false,
          message: `Academic session for Year ${year} Term ${term} already exists`
        });
      }
      
      // Begin transaction
      await client.query('BEGIN');
      
      // If setting as current, update all other sessions to not current
      if (isCurrent) {
        await client.query('UPDATE academic_sessions SET is_current = false');
      }
      
      // Insert new academic session
      const insertQuery = `
        INSERT INTO academic_sessions 
          (year, term, start_date, end_date, is_current, status)
        VALUES 
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;
      
      const insertResult = await client.query(insertQuery, [
        year, 
        term, 
        startDate, 
        endDate, 
        isCurrent || false, 
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
      // Rollback in case of error
      await client.query('ROLLBACK');
      
      console.error('Error creating academic session:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating academic session',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// PUT update academic session
router.put(
    '/academic-sessions/:id',
    authorizeRoles('admin'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        const { id } = req.params;
        const { year, term, startDate, endDate, isCurrent, status } = req.body;
        
        // Check if the session is already completed
        const checkQuery = 'SELECT status FROM academic_sessions WHERE id = $1';
        const checkResult = await client.query(checkQuery, [id]);
        
        if (checkResult.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Academic session not found'
          });
        }
        
        // If session is already completed, prevent updates
        if (checkResult.rows[0].status === 'completed') {
          return res.status(403).json({
            success: false,
            message: 'Completed academic sessions cannot be modified'
          });
        }
        
        // Begin transaction
        await client.query('BEGIN');
        
        // If setting as current, update all other sessions to not current
        if (isCurrent) {
          await client.query('UPDATE academic_sessions SET is_current = false');
        }
        
        // Update academic session
        const updateQuery = `
          UPDATE academic_sessions
          SET 
            year = $1,
            term = $2,
            start_date = $3,
            end_date = $4,
            is_current = $5,
            status = $6,
            updated_at = NOW()
          WHERE 
            id = $7
          RETURNING *
        `;
        
        const updateResult = await client.query(updateQuery, [
          year, 
          term, 
          startDate, 
          endDate, 
          isCurrent || false, 
          status,
          id
        ]);
        
        // Commit transaction
        await client.query('COMMIT');
        
        return res.status(200).json({
          success: true,
          message: 'Academic session updated successfully',
          data: updateResult.rows[0]
        });
      } catch (error) {
        // Rollback in case of error
        await client.query('ROLLBACK');
        
        console.error('Error updating academic session:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while updating academic session',
          error: error.message
        });
      } finally {
        client.release();
      }
    }
  );

// PATCH set current academic session
router.patch(
    '/academic-sessions/:id/set-current',
    authorizeRoles('admin'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        const { id } = req.params;
        
        // Check if the session is completed
        const checkQuery = 'SELECT status FROM academic_sessions WHERE id = $1';
        const checkResult = await client.query(checkQuery, [id]);
        
        if (checkResult.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Academic session not found'
          });
        }
        
        // If session is completed, prevent setting as current
        if (checkResult.rows[0].status === 'completed') {
          return res.status(403).json({
            success: false,
            message: 'Completed academic sessions cannot be set as current'
          });
        }
        
        // Begin transaction
        await client.query('BEGIN');
        
        // Update all sessions to not current
        await client.query('UPDATE academic_sessions SET is_current = false');
        
        // Set the specified session as current
        const updateQuery = `
          UPDATE academic_sessions
          SET 
            is_current = true,
            updated_at = NOW()
          WHERE 
            id = $1
          RETURNING *
        `;
        
        const updateResult = await client.query(updateQuery, [id]);
        
        // Commit transaction
        await client.query('COMMIT');
        
        return res.status(200).json({
          success: true,
          message: 'Academic session set as current successfully',
          data: updateResult.rows[0]
        });
      } catch (error) {
        // Rollback in case of error
        await client.query('ROLLBACK');
        
        console.error('Error setting current academic session:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while setting current academic session',
          error: error.message
        });
      } finally {
        client.release();
      }
    }
  );

  router.patch(
    '/academic-sessions/:id/status',
    authorizeRoles('admin'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        const { id } = req.params;
        const { status } = req.body;
        
        // Validate status value
        if (!['active', 'scheduled', 'completed'].includes(status)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid status value. Must be one of: active, scheduled, completed'
          });
        }
        
        // Check current status
        const checkQuery = 'SELECT status FROM academic_sessions WHERE id = $1';
        const checkResult = await client.query(checkQuery, [id]);
        
        if (checkResult.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Academic session not found'
          });
        }
        
        const currentStatus = checkResult.rows[0].status;
        
        // Prevent changing completed sessions back to active or scheduled
        if (currentStatus === 'completed' && status !== 'completed') {
          return res.status(403).json({
            success: false,
            message: 'Completed academic sessions cannot be changed back to active or scheduled'
          });
        }
        
        // Begin transaction
        await client.query('BEGIN');
        
        // Update session status
        const updateQuery = `
          UPDATE academic_sessions
          SET 
            status = $1,
            updated_at = NOW()
          WHERE 
            id = $2
          RETURNING *
        `;
        
        const updateResult = await client.query(updateQuery, [status, id]);
        
        // Commit transaction
        await client.query('COMMIT');
        
        return res.status(200).json({
          success: true,
          message: 'Academic session status updated successfully',
          data: updateResult.rows[0]
        });
      } catch (error) {
        // Rollback in case of error
        await client.query('ROLLBACK');
        
        console.error('Error updating academic session status:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while updating academic session status',
          error: error.message
        });
      } finally {
        client.release();
      }
    }
  );

// GET all grading systems
router.get(
  '/grading-systems',
  authorizeRoles('admin', 'teacher'),
  async (req, res) => {
    try {
      const { curriculumType, level, isActive } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (curriculumType) {
        queryParams.push(curriculumType);
        whereClause += `gs.curriculum_type = $${queryParams.length}`;
      }
      
      if (level) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(level);
        whereClause += `gs.level = $${queryParams.length}`;
      }
      
      if (isActive !== undefined) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(isActive === 'true');
        whereClause += `gs.is_active = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get grading systems
      const query = `
        SELECT 
          gs.id,
          gs.name,
          gs.curriculum_type,
          gs.level,
          gs.is_active,
          gs.created_at,
          gs.updated_at,
          (
            SELECT json_agg(json_build_object(
              'id', gp.id,
              'grade', gp.grade,
              'lower_mark', gp.lower_mark,
              'upper_mark', gp.upper_mark,
              'points', gp.points,
              'remarks', gp.remarks
            ) ORDER BY gp.lower_mark DESC)
            FROM grade_points gp 
            WHERE gp.grading_system_id = gs.id
          ) AS grade_points
        FROM 
          grading_systems gs
        ${whereClause}
        ORDER BY 
          gs.curriculum_type, gs.level, gs.name
      `;
      
      const result = await pool.query(query, queryParams);
      
      return res.status(200).json({
        success: true,
        message: 'Grading systems fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching grading systems:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching grading systems',
        error: error.message
      });
    }
  }
);

// POST create new grading system with grade points
router.post(
  '/grading-systems',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { name, curriculumType, level, isActive, gradePoints } = req.body;
      
      // Begin transaction
      await client.query('BEGIN');
      
      // Insert new grading system
      const insertSystemQuery = `
        INSERT INTO grading_systems 
          (name, curriculum_type, level, is_active)
        VALUES 
          ($1, $2, $3, $4)
        RETURNING *
      `;
      
      const systemResult = await client.query(insertSystemQuery, [
        name, 
        curriculumType, 
        level, 
        isActive || true
      ]);
      
      const gradingSystemId = systemResult.rows[0].id;
      
      // Insert grade points
      if (gradePoints && gradePoints.length > 0) {
        const gradePointsValues = gradePoints.map((point, index) => {
          return `($1, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5}, $${index * 5 + 6})`;
        }).join(', ');
        
        const gradePointsParams = [gradingSystemId];
        gradePoints.forEach(point => {
          gradePointsParams.push(
            point.grade,
            point.lowerMark,
            point.upperMark,
            point.points,
            point.remarks || null
          );
        });
        
        const insertPointsQuery = `
          INSERT INTO grade_points 
            (grading_system_id, grade, lower_mark, upper_mark, points, remarks)
          VALUES 
            ${gradePointsValues}
          RETURNING *
        `;
        
        await client.query(insertPointsQuery, gradePointsParams);
      }
      
      // Fetch the complete grading system with grade points
      const getSystemQuery = `
        SELECT 
          gs.*,
          (
            SELECT json_agg(gp.* ORDER BY gp.lower_mark DESC)
            FROM grade_points gp 
            WHERE gp.grading_system_id = gs.id
          ) AS grade_points
        FROM 
          grading_systems gs
        WHERE 
          gs.id = $1
      `;
      
      const getSystemResult = await client.query(getSystemQuery, [gradingSystemId]);
      
      // Commit transaction
      await client.query('COMMIT');
      
      return res.status(201).json({
        success: true,
        message: 'Grading system created successfully',
        data: getSystemResult.rows[0]
      });
    } catch (error) {
      // Rollback in case of error
      await client.query('ROLLBACK');
      
      console.error('Error creating grading system:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating grading system',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// PUT update grading system
router.put(
  '/grading-systems/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      const { name, curriculumType, level, isActive, gradePoints } = req.body;
      
      // Begin transaction
      await client.query('BEGIN');
      
      // Update grading system
      const updateSystemQuery = `
        UPDATE grading_systems
        SET 
          name = $1,
          curriculum_type = $2,
          level = $3,
          is_active = $4,
          updated_at = NOW()
        WHERE 
          id = $5
        RETURNING *
      `;
      
      const systemResult = await client.query(updateSystemQuery, [
        name, 
        curriculumType, 
        level, 
        isActive, 
        id
      ]);
      
      // Check if grading system was found
      if (systemResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({
          success: false,
          message: 'Grading system not found'
        });
      }
      
      // Delete existing grade points and insert new ones
      if (gradePoints && gradePoints.length > 0) {
        // Delete existing grade points
        await client.query('DELETE FROM grade_points WHERE grading_system_id = $1', [id]);
        
        // Insert new grade points
        const gradePointsValues = gradePoints.map((point, index) => {
          return `($1, $${index * 5 + 2}, $${index * 5 + 3}, $${index * 5 + 4}, $${index * 5 + 5}, $${index * 5 + 6})`;
        }).join(', ');
        
        const gradePointsParams = [id];
        gradePoints.forEach(point => {
          gradePointsParams.push(
            point.grade,
            point.lowerMark,
            point.upperMark,
            point.points,
            point.remarks || null
          );
        });
        
        const insertPointsQuery = `
          INSERT INTO grade_points 
            (grading_system_id, grade, lower_mark, upper_mark, points, remarks)
          VALUES 
            ${gradePointsValues}
          RETURNING *
        `;
        
        await client.query(insertPointsQuery, gradePointsParams);
      }
      
      // Fetch the complete grading system with grade points
      const getSystemQuery = `
        SELECT 
          gs.*,
          (
            SELECT json_agg(gp.* ORDER BY gp.lower_mark DESC)
            FROM grade_points gp 
            WHERE gp.grading_system_id = gs.id
          ) AS grade_points
        FROM 
          grading_systems gs
        WHERE 
          gs.id = $1
      `;
      
      const getSystemResult = await client.query(getSystemQuery, [id]);
      
      // Commit transaction
      await client.query('COMMIT');
      
      return res.status(200).json({
        success: true,
        message: 'Grading system updated successfully',
        data: getSystemResult.rows[0]
      });
    } catch (error) {
      // Rollback in case of error
      await client.query('ROLLBACK');
      
      console.error('Error updating grading system:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating grading system',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// GET all exam types
router.get(
  '/exam-types',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { curriculumType, category, isNationalExam } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (curriculumType) {
        queryParams.push(curriculumType);
        whereClause += `et.curriculum_type = $${queryParams.length}`;
      }
      
      if (category) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(category);
        whereClause += `et.category = $${queryParams.length}`;
      }
      
      if (isNationalExam !== undefined) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(isNationalExam === 'true');
        whereClause += `et.is_national_exam = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get exam types with grading system info
      const query = `
        SELECT 
          et.id,
          et.name,
          et.curriculum_type,
          et.category,
          et.weight_percentage,
          et.is_national_exam,
          et.grading_system_id,
          gs.name AS grading_system_name,
          et.created_at,
          et.updated_at
        FROM 
          exam_types et
        LEFT JOIN 
          grading_systems gs ON et.grading_system_id = gs.id
        ${whereClause}
        ORDER BY 
          et.curriculum_type, et.category, et.name
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

// POST create new exam type
router.post(
  '/exam-types',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { 
        name, 
        curriculumType, 
        category, 
        weightPercentage, 
        isNationalExam, 
        gradingSystemId 
      } = req.body;
      
      // Insert new exam type
      const insertQuery = `
        INSERT INTO exam_types 
          (name, curriculum_type, category, weight_percentage, is_national_exam, grading_system_id)
        VALUES 
          ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `;
      
      const result = await pool.query(insertQuery, [
        name, 
        curriculumType, 
        category, 
        weightPercentage, 
        isNationalExam || false,
        gradingSystemId
      ]);
      
      // Get grading system name for the response
      if (gradingSystemId) {
        const gradingSystemQuery = `
          SELECT name FROM grading_systems WHERE id = $1
        `;
        
        const gradingSystemResult = await pool.query(gradingSystemQuery, [gradingSystemId]);
        
        if (gradingSystemResult.rowCount > 0) {
          result.rows[0].grading_system_name = gradingSystemResult.rows[0].name;
        }
      }
      
      return res.status(201).json({
        success: true,
        message: 'Exam type created successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error creating exam type:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating exam type',
        error: error.message
      });
    }
  }
);

// PUT update exam type
router.put(
  '/exam-types/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { 
        name, 
        curriculumType, 
        category, 
        weightPercentage, 
        isNationalExam, 
        gradingSystemId 
      } = req.body;
      
      // Update exam type
      const updateQuery = `
        UPDATE exam_types
        SET 
          name = $1,
          curriculum_type = $2,
          category = $3,
          weight_percentage = $4,
          is_national_exam = $5,
          grading_system_id = $6,
          updated_at = NOW()
        WHERE 
          id = $7
        RETURNING *
      `;
      
      const result = await pool.query(updateQuery, [
        name, 
        curriculumType, 
        category, 
        weightPercentage, 
        isNationalExam,
        gradingSystemId,
        id
      ]);
      
      // Check if exam type was found
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Exam type not found'
        });
      }
      
      // Get grading system name for the response
      if (gradingSystemId) {
        const gradingSystemQuery = `
          SELECT name FROM grading_systems WHERE id = $1
        `;
        
        const gradingSystemResult = await pool.query(gradingSystemQuery, [gradingSystemId]);
        
        if (gradingSystemResult.rowCount > 0) {
          result.rows[0].grading_system_name = gradingSystemResult.rows[0].name;
        }
      }
      
      return res.status(200).json({
        success: true,
        message: 'Exam type updated successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error updating exam type:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating exam type',
        error: error.message
      });
    }
  }
);

// GET academic settings reference data in a single request
router.get(
  '/reference-data',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      // Start a transaction
      const client = await pool.connect();
      
      try {
        // Query for current academic session
        const currentSessionQuery = `
          SELECT 
            id, year, term, start_date, end_date, is_current, status
          FROM 
            academic_sessions
          WHERE 
            is_current = true
          LIMIT 1
        `;
        
        const currentSessionResult = await client.query(currentSessionQuery);
        
        // Query for curriculum types (from schema constraint)
        const curriculumTypes = ['CBC', '844'];
        
        // Query for active grading systems
        const gradingSystemsQuery = `
          SELECT 
            id, name, curriculum_type, level
          FROM 
            grading_systems
          WHERE 
            is_active = true
          ORDER BY 
            curriculum_type, level, name
        `;
        
        const gradingSystemsResult = await client.query(gradingSystemsQuery);
        
        return res.status(200).json({
          success: true,
          message: 'Academic settings reference data fetched successfully',
          data: {
            currentSession: currentSessionResult.rows[0] || null,
            curriculumTypes: curriculumTypes,
            gradingSystems: gradingSystemsResult.rows
          }
        });
      } finally {
        // Release the client back to the pool
        client.release();
      }
    } catch (error) {
      console.error('Error fetching academic settings reference data:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching academic settings reference data',
        error: error.message
      });
    }
  }
);

export default router;