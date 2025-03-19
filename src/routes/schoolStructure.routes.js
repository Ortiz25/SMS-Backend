import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// ========== DEPARTMENT ROUTES ==========

// GET all departments
router.get(
  '/departments',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const query = `
        SELECT 
          d.id, 
          d.name, 
          d.description, 
          d.head_teacher_id,
          CONCAT(t.first_name, ' ', t.last_name) as head_teacher_name
        FROM 
          departments d
        LEFT JOIN 
          teachers t ON d.head_teacher_id = t.id
        ORDER BY 
          d.name ASC
      `;
      
      const result = await pool.query(query);
      
      return res.status(200).json({
        success: true,
        message: 'Departments fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching departments:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching departments',
        error: error.message
      });
    }
  }
);

// GET department by ID
router.get(
  '/departments/:id',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Ensure id is a valid integer
      const departmentId = parseInt(id);
      if (isNaN(departmentId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid department ID. Must be a number.'
        });
      }
      
      const query = `
        SELECT 
          d.id, 
          d.name, 
          d.description, 
          d.head_teacher_id,
          CONCAT(t.first_name, ' ', t.last_name) as head_teacher_name
        FROM 
          departments d
        LEFT JOIN 
          teachers t ON d.head_teacher_id = t.id
        WHERE 
          d.id = $1
      `;
      
      const result = await pool.query(query, [departmentId]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Department not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Department fetched successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching department:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching department',
        error: error.message
      });
    }
  }
);

// POST create new department
router.post(
  '/departments',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { name, description, head_teacher_id } = req.body;
      
      // Validate required fields
      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Department name is required'
        });
      }
      
      // Check if head teacher exists if provided
      if (head_teacher_id) {
        const teacherCheck = await client.query(
          'SELECT id FROM teachers WHERE id = $1',
          [head_teacher_id]
        );
        
        if (teacherCheck.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Head teacher not found'
          });
        }
      }
      
      // Insert new department
      const insertQuery = `
        INSERT INTO departments 
          (name, description, head_teacher_id)
        VALUES 
          ($1, $2, $3)
        RETURNING *
      `;
      
      const insertResult = await client.query(insertQuery, [
        name, 
        description || null, 
        head_teacher_id || null
      ]);
      
      // Get complete department information with teacher name
      const newDepartmentId = insertResult.rows[0].id;
      const detailQuery = `
        SELECT 
          d.id, 
          d.name, 
          d.description, 
          d.head_teacher_id,
          CONCAT(t.first_name, ' ', t.last_name) as head_teacher_name
        FROM 
          departments d
        LEFT JOIN 
          teachers t ON d.head_teacher_id = t.id
        WHERE 
          d.id = $1
      `;
      
      const detailResult = await client.query(detailQuery, [newDepartmentId]);
      
      return res.status(201).json({
        success: true,
        message: 'Department created successfully',
        data: detailResult.rows[0]
      });
    } catch (error) {
      console.error('Error creating department:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating department',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// PUT update department
router.put(
  '/departments/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      const { name, description, head_teacher_id } = req.body;
      
      // Ensure id is a valid integer
      const departmentId = parseInt(id);
      if (isNaN(departmentId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid department ID. Must be a number.'
        });
      }
      
      // Validate required fields
      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Department name is required'
        });
      }
      
      // Check if department exists
      const departmentCheck = await client.query(
        'SELECT id FROM departments WHERE id = $1',
        [departmentId]
      );
      
      if (departmentCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Department not found'
        });
      }
      
      // Check if head teacher exists if provided
      if (head_teacher_id) {
        const teacherCheck = await client.query(
          'SELECT id FROM teachers WHERE id = $1',
          [head_teacher_id]
        );
        
        if (teacherCheck.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Head teacher not found'
          });
        }
      }
      
      // Update department
      const updateQuery = `
        UPDATE departments
        SET 
          name = $1,
          description = $2,
          head_teacher_id = $3,
          updated_at = NOW()
        WHERE 
          id = $4
        RETURNING *
      `;
      
      await client.query(updateQuery, [
        name, 
        description || null, 
        head_teacher_id || null,
        departmentId
      ]);
      
      // Get updated department with teacher info
      const detailQuery = `
        SELECT 
          d.id, 
          d.name, 
          d.description, 
          d.head_teacher_id,
          CONCAT(t.first_name, ' ', t.last_name) as head_teacher_name
        FROM 
          departments d
        LEFT JOIN 
          teachers t ON d.head_teacher_id = t.id
        WHERE 
          d.id = $1
      `;
      
      const detailResult = await client.query(detailQuery, [departmentId]);
      
      return res.status(200).json({
        success: true,
        message: 'Department updated successfully',
        data: detailResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating department:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating department',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// DELETE department
router.delete(
  '/departments/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      
      // Ensure id is a valid integer
      const departmentId = parseInt(id);
      if (isNaN(departmentId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid department ID. Must be a number.'
        });
      }
      
      // Check if department exists
      const departmentCheck = await client.query(
        'SELECT id FROM departments WHERE id = $1',
        [departmentId]
      );
      
      if (departmentCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Department not found'
        });
      }
      
      // Check if department has subjects
      const subjectsCheck = await client.query(
        'SELECT COUNT(*) FROM subjects WHERE department_id = $1',
        [departmentId]
      );
      
      if (parseInt(subjectsCheck.rows[0].count) > 0) {
        return res.status(400).json({
          success: false,
          message: 'Department has subjects assigned. Please reassign or delete these subjects first.'
        });
      }
      
      // Delete department
      await client.query('DELETE FROM departments WHERE id = $1', [departmentId]);
      
      return res.status(200).json({
        success: true,
        message: 'Department deleted successfully'
      });
    } catch (error) {
      console.error('Error deleting department:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while deleting department',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// ========== CLASS ROUTES ==========

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

// GET class by ID
router.get(
  '/classes/:id',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const { id } = req.params;
      
      // Ensure id is a valid integer
      const classId = parseInt(id);
      if (isNaN(classId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid class ID. Must be a number.'
        });
      }
      
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
        WHERE 
          c.id = $1
      `;
      
      const result = await pool.query(query, [classId]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Class not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Class fetched successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error fetching class:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching class',
        error: error.message
      });
    }
  }
);

// POST create new class
router.post(
  '/classes',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { name, curriculum_type, level, stream, class_teacher_id, academic_session_id, capacity } = req.body;
      
      // Validate required fields
      if (!name || !curriculum_type || !level || !academic_session_id) {
        return res.status(400).json({
          success: false,
          message: 'Name, curriculum type, level and academic session are required'
        });
      }
      
      // Validate curriculum type
      if (!['CBC', '844'].includes(curriculum_type)) {
        return res.status(400).json({
          success: false,
          message: 'Curriculum type must be either CBC or 844'
        });
      }
      
      // Check if academic session exists
      const sessionCheck = await client.query(
        'SELECT id FROM academic_sessions WHERE id = $1',
        [academic_session_id]
      );
      
      if (sessionCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Academic session not found'
        });
      }
      
      // Check if class teacher exists if provided
      if (class_teacher_id) {
        const teacherCheck = await client.query(
          'SELECT id FROM teachers WHERE id = $1',
          [class_teacher_id]
        );
        
        if (teacherCheck.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Class teacher not found'
          });
        }
      }
      
      // Check if class with same level, stream and academic session already exists
      const duplicateCheck = await client.query(
        'SELECT id FROM classes WHERE level = $1 AND stream = $2 AND academic_session_id = $3',
        [level, stream, academic_session_id]
      );
      
      if (duplicateCheck.rowCount > 0) {
        return res.status(400).json({
          success: false,
          message: 'A class with this level, stream and academic session already exists'
        });
      }
      
      // Insert new class
      const insertQuery = `
        INSERT INTO classes 
          (name, curriculum_type, level, stream, class_teacher_id, academic_session_id, capacity)
        VALUES 
          ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `;
      
      const insertResult = await client.query(insertQuery, [
        name, 
        curriculum_type, 
        level,
        stream || null,
        class_teacher_id || null,
        academic_session_id,
        capacity || null
      ]);
      
      // Get complete class information with teacher and session info
      const newClassId = insertResult.rows[0].id;
      const detailQuery = `
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
        WHERE 
          c.id = $1
      `;
      
      const detailResult = await client.query(detailQuery, [newClassId]);
      
      return res.status(201).json({
        success: true,
        message: 'Class created successfully',
        data: detailResult.rows[0]
      });
    } catch (error) {
      console.error('Error creating class:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating class',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// PUT update class
router.put(
  '/classes/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      const { name, curriculum_type, level, stream, class_teacher_id, academic_session_id, capacity } = req.body;
      
      // Ensure id is a valid integer
      const classId = parseInt(id);
      if (isNaN(classId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid class ID. Must be a number.'
        });
      }
      
      // Validate required fields
      if (!name || !curriculum_type || !level || !academic_session_id) {
        return res.status(400).json({
          success: false,
          message: 'Name, curriculum type, level and academic session are required'
        });
      }
      
      // Validate curriculum type
      if (!['CBC', '844'].includes(curriculum_type)) {
        return res.status(400).json({
          success: false,
          message: 'Curriculum type must be either CBC or 844'
        });
      }
      
      // Check if class exists
      const classCheck = await client.query(
        'SELECT id FROM classes WHERE id = $1',
        [classId]
      );
      
      if (classCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Class not found'
        });
      }
      
      // Check if academic session exists
      const sessionCheck = await client.query(
        'SELECT id FROM academic_sessions WHERE id = $1',
        [academic_session_id]
      );
      
      if (sessionCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Academic session not found'
        });
      }
      
      // Check if class teacher exists if provided
      if (class_teacher_id) {
        const teacherCheck = await client.query(
          'SELECT id FROM teachers WHERE id = $1',
          [class_teacher_id]
        );
        
        if (teacherCheck.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Class teacher not found'
          });
        }
      }
      
      // Check if class with same level, stream and academic session already exists (excluding current class)
      const duplicateCheck = await client.query(
        'SELECT id FROM classes WHERE level = $1 AND stream = $2 AND academic_session_id = $3 AND id != $4',
        [level, stream, academic_session_id, classId]
      );
      
      if (duplicateCheck.rowCount > 0) {
        return res.status(400).json({
          success: false,
          message: 'A class with this level, stream and academic session already exists'
        });
      }
      
      // Update class
      const updateQuery = `
        UPDATE classes
        SET 
          name = $1,
          curriculum_type = $2,
          level = $3,
          stream = $4,
          class_teacher_id = $5,
          academic_session_id = $6,
          capacity = $7,
          updated_at = NOW()
        WHERE 
          id = $8
        RETURNING *
      `;
      
      await client.query(updateQuery, [
        name, 
        curriculum_type, 
        level,
        stream || null,
        class_teacher_id || null,
        academic_session_id,
        capacity || null,
        classId
      ]);
      
      // Get updated class with teacher and session info
      const detailQuery = `
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
        WHERE 
          c.id = $1
      `;
      
      const detailResult = await client.query(detailQuery, [classId]);
      
      return res.status(200).json({
        success: true,
        message: 'Class updated successfully',
        data: detailResult.rows[0]
      });
    } catch (error) {
      console.error('Error updating class:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating class',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// DELETE class
router.delete(
  '/classes/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    const client = await pool.connect();
    
    try {
      const { id } = req.params;
      
      // Ensure id is a valid integer
      const classId = parseInt(id);
      if (isNaN(classId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid class ID. Must be a number.'
        });
      }
      
      // Check if class exists
      const classCheck = await client.query(
        'SELECT id FROM classes WHERE id = $1',
        [classId]
      );
      
      if (classCheck.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Class not found'
        });
      }
      
      // Check if class has student enrollments
      const enrollmentsCheck = await client.query(
        'SELECT COUNT(*) FROM student_subjects WHERE class_id = $1',
        [classId]
      );
      
      if (parseInt(enrollmentsCheck.rows[0].count) > 0) {
        return res.status(400).json({
          success: false,
          message: 'Class has student enrollments. Please unenroll students first.'
        });
      }
      
      // Begin transaction to delete related data
      await client.query('BEGIN');
      
      // Delete timetable entries
      await client.query('DELETE FROM timetable WHERE class_id = $1', [classId]);
      
      // Delete teacher-subject assignments
      await client.query('DELETE FROM teacher_subjects WHERE class_id = $1', [classId]);
      
      // Delete class
      await client.query('DELETE FROM classes WHERE id = $1', [classId]);
      
      // Commit transaction
      await client.query('COMMIT');
      
      return res.status(200).json({
        success: true,
        message: 'Class and related data deleted successfully'
      });
    } catch (error) {
      // Rollback transaction on error
      await client.query('ROLLBACK');
      
      console.error('Error deleting class:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while deleting class',
        error: error.message
      });
    } finally {
      client.release();
    }
  }
);

// ========== ROOM ROUTES ==========

// GET all room categories
router.get(
  '/room-categories',
  authorizeRoles('admin', 'teacher', 'staff'),
  async (req, res) => {
    try {
      const query = `
        SELECT 
          id, 
          name, 
          description,
          created_at
        FROM 
          room_categories
        ORDER BY 
          name ASC
      `;
      
      const result = await pool.query(query);
      
      return res.status(200).json({
        success: true,
        message: 'Room categories fetched successfully',
        data: result.rows
      });
    } catch (error) {
      console.error('Error fetching room categories:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while fetching room categories',
        error: error.message
      });
    }
  }
);

// POST create room category
router.post(
  '/room-categories',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { name, description } = req.body;
      
      // Validate required fields
      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Category name is required'
        });
      }
      
      // Insert new room category
      const insertQuery = `
        INSERT INTO room_categories 
          (name, description)
        VALUES 
          ($1, $2)
        RETURNING *
      `;
      
      const result = await pool.query(insertQuery, [name, description || null]);
      
      return res.status(201).json({
        success: true,
        message: 'Room category created successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error creating room category:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while creating room category',
        error: error.message
      });
    }
  }
);

// PUT update room category
router.put(
  '/room-categories/:id',
  authorizeRoles('admin'),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description } = req.body;
      
      // Ensure id is a valid integer
      const categoryId = parseInt(id);
      if (isNaN(categoryId)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid category ID. Must be a number.'
        });
      }
      
      // Validate required fields
      if (!name) {
        return res.status(400).json({
          success: false,
          message: 'Category name is required'
        });
      }
      
      // Update room category
      const updateQuery = `
        UPDATE room_categories
        SET 
          name = $1,
          description = $2
        WHERE 
          id = $3
        RETURNING *
      `;
      
      const result = await pool.query(updateQuery, [name, description || null, categoryId]);
      
      if (result.rowCount === 0) {
        return res.status(404).json({
          success: false,
          message: 'Room category not found'
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Room category updated successfully',
        data: result.rows[0]
      });
    } catch (error) {
      console.error('Error updating room category:', error);
      return res.status(500).json({
        success: false,
        message: 'An error occurred while updating room category',
        error: error.message
      });
    }
  }
);

// DELETE room category
router.delete(
    '/room-categories/:id',
    authorizeRoles('admin'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        const { id } = req.params;
        
        // Ensure id is a valid integer
        const categoryId = parseInt(id);
        if (isNaN(categoryId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid category ID. Must be a number.'
          });
        }
        
        // Check if category exists
        const categoryCheck = await client.query(
          'SELECT id FROM room_categories WHERE id = $1',
          [categoryId]
        );
        
        if (categoryCheck.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Room category not found'
          });
        }
        
        // Check if rooms with this category exist
        const roomsCheck = await client.query(
          'SELECT COUNT(*) FROM rooms WHERE category_id = $1',
          [categoryId]
        );
        
        if (parseInt(roomsCheck.rows[0].count) > 0) {
          return res.status(400).json({
            success: false,
            message: 'Rooms with this category exist. Please reassign or delete these rooms first.'
          });
        }
        
        // Delete category
        await client.query('DELETE FROM room_categories WHERE id = $1', [categoryId]);
        
        return res.status(200).json({
          success: true,
          message: 'Room category deleted successfully'
        });
      } catch (error) {
        console.error('Error deleting room category:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while deleting room category',
          error: error.message
        });
      } finally {
        client.release();
      }
    }
  );
  
  // GET all rooms
  router.get(
    '/rooms',
    authorizeRoles('admin', 'teacher', 'staff'),
    async (req, res) => {
      try {
        const { category_id, is_lab, building, is_available } = req.query;
        
        // Build the WHERE clause based on filters
        let whereClause = '';
        const queryParams = [];
        
        if (category_id) {
          queryParams.push(category_id);
          whereClause += `r.category_id = $${queryParams.length}`;
        }
        
        if (is_lab !== undefined) {
          if (whereClause) whereClause += ' AND ';
          queryParams.push(is_lab === 'true');
          whereClause += `r.is_lab = $${queryParams.length}`;
        }
        
        if (building) {
          if (whereClause) whereClause += ' AND ';
          queryParams.push(building);
          whereClause += `r.building = $${queryParams.length}`;
        }
        
        if (is_available !== undefined) {
          if (whereClause) whereClause += ' AND ';
          queryParams.push(is_available === 'true');
          whereClause += `r.is_available = $${queryParams.length}`;
        }
        
        // If any filters are applied, add WHERE to the query
        if (whereClause) {
          whereClause = 'WHERE ' + whereClause;
        }
        
        // Query to get rooms with category info
        const query = `
          SELECT 
            r.id,
            r.room_number,
            r.name,
            r.category_id,
            rc.name AS category_name,
            r.capacity,
            r.building,
            r.floor,
            r.is_lab,
            r.is_available,
            r.notes
          FROM 
            rooms r
          LEFT JOIN 
            room_categories rc ON r.category_id = rc.id
          ${whereClause}
          ORDER BY 
            r.building, r.floor, r.room_number
        `;
        
        const result = await pool.query(query, queryParams);
        
        return res.status(200).json({
          success: true,
          message: 'Rooms fetched successfully',
          data: result.rows
        });
      } catch (error) {
        console.error('Error fetching rooms:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while fetching rooms',
          error: error.message
        });
      }
    }
  );
  
  // GET room by ID
  router.get(
    '/rooms/:id',
    authorizeRoles('admin', 'teacher', 'staff'),
    async (req, res) => {
      try {
        const { id } = req.params;
        
        // Ensure id is a valid integer
        const roomId = parseInt(id);
        if (isNaN(roomId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid room ID. Must be a number.'
          });
        }
        
        const query = `
          SELECT 
            r.id,
            r.room_number,
            r.name,
            r.category_id,
            rc.name AS category_name,
            r.capacity,
            r.building,
            r.floor,
            r.is_lab,
            r.is_available,
            r.notes
          FROM 
            rooms r
          LEFT JOIN 
            room_categories rc ON r.category_id = rc.id
          WHERE 
            r.id = $1
        `;
        
        const result = await pool.query(query, [roomId]);
        
        if (result.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Room not found'
          });
        }
        
        return res.status(200).json({
          success: true,
          message: 'Room fetched successfully',
          data: result.rows[0]
        });
      } catch (error) {
        console.error('Error fetching room:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while fetching room',
          error: error.message
        });
      }
    }
  );
  
  // POST create new room
  router.post(
    '/rooms',
    authorizeRoles('admin'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        const { 
          room_number, 
          name, 
          category_id, 
          capacity, 
          building, 
          floor, 
          is_lab, 
          is_available, 
          notes 
        } = req.body;
        
        // Validate required fields
        if (!room_number || !name) {
          return res.status(400).json({
            success: false,
            message: 'Room number and name are required'
          });
        }
        
        // Check if room number already exists
        const roomCheck = await client.query(
          'SELECT id FROM rooms WHERE room_number = $1',
          [room_number]
        );
        
        if (roomCheck.rowCount > 0) {
          return res.status(400).json({
            success: false,
            message: 'A room with this room number already exists'
          });
        }
        
        // Check if category exists if provided
        if (category_id) {
          const categoryCheck = await client.query(
            'SELECT id FROM room_categories WHERE id = $1',
            [category_id]
          );
          
          if (categoryCheck.rowCount === 0) {
            return res.status(404).json({
              success: false,
              message: 'Room category not found'
            });
          }
        }
        
        // Insert new room
        const insertQuery = `
          INSERT INTO rooms 
            (room_number, name, category_id, capacity, building, floor, is_lab, is_available, notes)
          VALUES 
            ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `;
        
        const insertResult = await client.query(insertQuery, [
          room_number,
          name,
          category_id || null,
          capacity || null,
          building || null,
          floor || null,
          is_lab || false,
          is_available !== false,
          notes || null
        ]);
        
        // Get complete room information with category name
        const newRoomId = insertResult.rows[0].id;
        const detailQuery = `
          SELECT 
            r.id,
            r.room_number,
            r.name,
            r.category_id,
            rc.name AS category_name,
            r.capacity,
            r.building,
            r.floor,
            r.is_lab,
            r.is_available,
            r.notes
          FROM 
            rooms r
          LEFT JOIN 
            room_categories rc ON r.category_id = rc.id
          WHERE 
            r.id = $1
        `;
        
        const detailResult = await client.query(detailQuery, [newRoomId]);
        
        return res.status(201).json({
          success: true,
          message: 'Room created successfully',
          data: detailResult.rows[0]
        });
      } catch (error) {
        console.error('Error creating room:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while creating room',
          error: error.message
        });
      } finally {
        client.release();
      }
    }
  );
  
  // PUT update room
  router.put(
    '/rooms/:id',
    authorizeRoles('admin'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        const { id } = req.params;
        const { 
          room_number, 
          name, 
          category_id, 
          capacity, 
          building, 
          floor, 
          is_lab, 
          is_available, 
          notes 
        } = req.body;
        
        // Ensure id is a valid integer
        const roomId = parseInt(id);
        if (isNaN(roomId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid room ID. Must be a number.'
          });
        }
        
        // Validate required fields
        if (!room_number || !name) {
          return res.status(400).json({
            success: false,
            message: 'Room number and name are required'
          });
        }
        
        // Check if room exists
        const roomExistsCheck = await client.query(
          'SELECT id FROM rooms WHERE id = $1',
          [roomId]
        );
        
        if (roomExistsCheck.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Room not found'
          });
        }
        
        // Check if another room with the same room number exists
        const roomNumberCheck = await client.query(
          'SELECT id FROM rooms WHERE room_number = $1 AND id != $2',
          [room_number, roomId]
        );
        
        if (roomNumberCheck.rowCount > 0) {
          return res.status(400).json({
            success: false,
            message: 'Another room with this room number already exists'
          });
        }
        
        // Check if category exists if provided
        if (category_id) {
          const categoryCheck = await client.query(
            'SELECT id FROM room_categories WHERE id = $1',
            [category_id]
          );
          
          if (categoryCheck.rowCount === 0) {
            return res.status(404).json({
              success: false,
              message: 'Room category not found'
            });
          }
        }
        
        // Update room
        const updateQuery = `
          UPDATE rooms
          SET 
            room_number = $1,
            name = $2,
            category_id = $3,
            capacity = $4,
            building = $5,
            floor = $6,
            is_lab = $7,
            is_available = $8,
            notes = $9,
            updated_at = NOW()
          WHERE 
            id = $10
          RETURNING *
        `;
        
        await client.query(updateQuery, [
          room_number,
          name,
          category_id || null,
          capacity || null,
          building || null,
          floor || null,
          is_lab || false,
          is_available !== false,
          notes || null,
          roomId
        ]);
        
        // Get updated room with category info
        const detailQuery = `
          SELECT 
            r.id,
            r.room_number,
            r.name,
            r.category_id,
            rc.name AS category_name,
            r.capacity,
            r.building,
            r.floor,
            r.is_lab,
            r.is_available,
            r.notes
          FROM 
            rooms r
          LEFT JOIN 
            room_categories rc ON r.category_id = rc.id
          WHERE 
            r.id = $1
        `;
        
        const detailResult = await client.query(detailQuery, [roomId]);
        
        return res.status(200).json({
          success: true,
          message: 'Room updated successfully',
          data: detailResult.rows[0]
        });
      } catch (error) {
        console.error('Error updating room:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while updating room',
          error: error.message
        });
      } finally {
        client.release();
      }
    }
  );
  
  // DELETE room
  router.delete(
    '/rooms/:id',
    authorizeRoles('admin'),
    async (req, res) => {
      const client = await pool.connect();
      
      try {
        const { id } = req.params;
        
        // Ensure id is a valid integer
        const roomId = parseInt(id);
        if (isNaN(roomId)) {
          return res.status(400).json({
            success: false,
            message: 'Invalid room ID. Must be a number.'
          });
        }
        
        // Check if room exists
        const roomCheck = await client.query(
          'SELECT id FROM rooms WHERE id = $1',
          [roomId]
        );
        
        if (roomCheck.rowCount === 0) {
          return res.status(404).json({
            success: false,
            message: 'Room not found'
          });
        }
        
        // Check if timetable entries are using this room
        const timetableCheck = await client.query(
          'SELECT COUNT(*) FROM timetable WHERE room_number = (SELECT room_number FROM rooms WHERE id = $1)',
          [roomId]
        );
        
        if (parseInt(timetableCheck.rows[0].count) > 0) {
          return res.status(400).json({
            success: false,
            message: 'Room is being used in timetable. Please update timetable entries first.'
          });
        }
        
        // Delete room
        await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
        
        return res.status(200).json({
          success: true,
          message: 'Room deleted successfully'
        });
      } catch (error) {
        console.error('Error deleting room:', error);
        return res.status(500).json({
          success: false,
          message: 'An error occurred while deleting room',
          error: error.message
        });
      } finally {
        client.release();
      }
    }
  );
  
  
  export default router;