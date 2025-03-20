import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);



router.get('/', authorizeRoles('admin', 'teacher', 'staff'), async (req, res) => {
  try {
    // Extract query parameters for filtering
    const { curriculum_type, level, department_id, code } = req.query;
       console.log(req.body)
    // Base query
    let query = 'SELECT s.*, d.name as department_name FROM subjects s LEFT JOIN departments d ON s.department_id = d.id WHERE 1=1';
    const params = [];
    
    // Add optional filters
    if (curriculum_type) {
      query += ' AND s.curriculum_type = $' + (params.length + 1);
      params.push(curriculum_type);
    }
    
    if (level) {
      query += ' AND s.level = $' + (params.length + 1);
      params.push(level);
    }
    
    if (department_id) {
      query += ' AND s.department_id = $' + (params.length + 1);
      params.push(department_id);
    }
    
    if (code) {
      query += ' AND s.code = $' + (params.length + 1);
      params.push(code);
    }
    
    // Order by subject name
    query += ' ORDER BY s.name ASC';
    
    // Execute query
    const { rows } = await pool.query(query, params);
    
    return res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error('Error fetching subjects:', error);
    return res.status(500).json({
      success: false,
      message: 'Server error while fetching subjects',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});


// GET all classes
router.get(
  '/classes',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { academicSessionId, curriculumType, level } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (academicSessionId) {
        queryParams.push(academicSessionId);
        whereClause += `c.academic_session_id = $${queryParams.length}`;
      }
      
      if (curriculumType) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(curriculumType);
        whereClause += `c.curriculum_type = $${queryParams.length}`;
      }
      
      if (level) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(level);
        whereClause += `c.level = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get classes with teacher info
      const query = `
        SELECT 
          c.id,
          c.name,
          c.curriculum_type,
          c.level,
          c.stream,
          c.class_teacher_id,
          CONCAT(t.first_name, ' ', t.last_name) AS class_teacher_name,
          c.academic_session_id,
          CONCAT(a.year, ' Term ', a.term) AS academic_session_name,
          c.capacity
        FROM 
          classes c
        LEFT JOIN 
          teachers t ON c.class_teacher_id = t.id
        LEFT JOIN 
          academic_sessions a ON c.academic_session_id = a.id
        ${whereClause}
        ORDER BY 
          c.level, c.stream
      `;
      
      const result = await pool.query(query, queryParams);
      
      return res.status(200).json({
        success: true,
        message: 'Classes fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching classes:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching classes',
        error: error.message
      });
    }
  }
);

// GET all teachers - fixed to match schema
router.get(
    '/teachers',
    authorizeRoles('admin', 'teacher', 'staff'),
    async (req, res) => {
      try {
        const { department, subjectSpecialization, status } = req.query;
        
        // Build the WHERE clause based on filters
        let whereClause = '';
        const queryParams = [];
        
        if (department) {
          queryParams.push(department);
          whereClause += `t.department = $${queryParams.length}`;
        }
        
        if (subjectSpecialization) {
          if (whereClause) whereClause += ' AND ';
          queryParams.push(`%${subjectSpecialization}%`);
          whereClause += `t.subject_specialization::text ILIKE $${queryParams.length}`;
        }
        
        if (status) {
          if (whereClause) whereClause += ' AND ';
          queryParams.push(status);
          whereClause += `t.status = $${queryParams.length}`;
        }
        
        // If any filters are applied, add WHERE to the query
        if (whereClause) {
          whereClause = 'WHERE ' + whereClause;
        }
        
        // Query to get teachers - fixed to use 'department' rather than 'department_id'
        const query = `
          SELECT 
            t.id,
            t.staff_id,
            t.first_name,
            t.last_name,
            CONCAT(t.first_name, ' ', t.last_name) AS full_name,
            t.email,
            t.phone_primary,
            t.subject_specialization,
            t.department,
            d.name AS department_name,
            t.employment_type,
            t.status,
            t.tsc_number
          FROM 
            teachers t
          LEFT JOIN 
            departments d ON t.department = d.id
          ${whereClause}
          ORDER BY 
            t.last_name, t.first_name
        `;
        
        const result = await pool.query(query, queryParams);
        
        return res.status(200).json({
          success: true,
          message: 'Teachers fetched successfully',
          data: result.rows
        });
      } catch (error) {
        console.error('Error fetching teachers:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while fetching teachers',
          error: error.message
        });
      }
    }
  );
  
// GET all subjects
router.get(
  '/subjects',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { departmentId, curriculumType, level } = req.query;
      
      // Build the WHERE clause based on filters
      let whereClause = '';
      const queryParams = [];
      
      if (departmentId) {
        queryParams.push(departmentId);
        whereClause += `s.department_id = $${queryParams.length}`;
      }
      
      if (curriculumType) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(curriculumType);
        whereClause += `s.curriculum_type = $${queryParams.length}`;
      }
      
      if (level) {
        if (whereClause) whereClause += ' AND ';
        queryParams.push(level);
        whereClause += `s.level = $${queryParams.length}`;
      }
      
      // If any filters are applied, add WHERE to the query
      if (whereClause) {
        whereClause = 'WHERE ' + whereClause;
      }
      
      // Query to get subjects with department info
      const query = `
        SELECT 
          s.id,
          s.name,
          s.code,
          s.curriculum_type,
          s.department_id,
          d.name AS department_name,
          s.level,
          s.passing_marks
        FROM 
          subjects s
        LEFT JOIN 
          departments d ON s.department_id = d.id
        ${whereClause}
        ORDER BY 
          s.name
      `;
      
      const result = await pool.query(query, queryParams);
      
      return res.status(200).json({
        success: true,
        message: 'Subjects fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching subjects:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching subjects',
        error: error.message
      });
    }
  }
);

// GET reference data (classes, teachers, subjects) in a single request
router.get(
  '/reference-data',
  
  async (req, res) => {
    try {
      console.log("reached")
      const { academicSessionId } = req.query;
       
      // Start a transaction
      const client = await pool.connect();
      
      try {
        // Query for classes
        let classesQuery = `
          SELECT 
            c.id,
            c.name,
            c.curriculum_type,
            c.level,
            c.stream,
            c.class_teacher_id,
            c.academic_session_id
          FROM 
            classes c
        `;
        
        // Add academic session filter if provided
        if (academicSessionId) {
          classesQuery += ` WHERE c.academic_session_id = $1`;
        }
        
        classesQuery += ` ORDER BY c.level, c.stream`;
        
        const classesResult = await client.query(
          classesQuery, 
          academicSessionId ? [academicSessionId] : []
        );
        
        // Query for teachers
        const teachersQuery = `
          SELECT 
            t.id,
            t.staff_id,
            t.first_name,
            t.last_name,
            CONCAT(t.first_name, ' ', t.last_name) AS full_name,
            t.subject_specialization,
            t.status
          FROM 
            teachers t
          WHERE 
            t.status = 'active'
          ORDER BY 
            t.last_name, t.first_name
        `;
        
        const teachersResult = await client.query(teachersQuery);
        
        // Query for subjects
        const subjectsQuery = `
          SELECT 
            s.id,
            s.name,
            s.code,
            s.curriculum_type,
            s.level,
            s.department_id
          FROM 
            subjects s
          ORDER BY 
            s.name
        `;
        
        const subjectsResult = await client.query(subjectsQuery);
        
        // Query for current academic session
        const sessionQuery = `
          SELECT 
            id,
            year,
            term,
            is_current
          FROM 
            academic_sessions
          WHERE 
            is_current = true
          LIMIT 1
        `;
        
        const sessionResult = await client.query(sessionQuery);
        
        return res.status(200).json({
          success: true,
          message: 'Reference data fetched successfully',
          data: {
            classes: classesResult.rows,
            teachers: teachersResult.rows,
            subjects: subjectsResult.rows,
            currentSession: sessionResult.rows[0] || null
          }
        });
      } finally {
        // Release the client back to the pool
        client.release();
      }
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

export default router