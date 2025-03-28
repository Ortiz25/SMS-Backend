// src/routes/class.routes.js
import express from "express";
import { validate } from "../middleware/validate.js";
import { body, query } from "express-validator";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";
import { createClassModel } from "../models/classModel.js";
import pool from "../config/database.js";

const router = express.Router();
const classModel = createClassModel();

// Validation rules
const classValidation = [
  body("name").notEmpty().trim().withMessage("Class name is required"),
  body("curriculum_type")
    .isIn(["CBC", "844"])
    .withMessage("Curriculum type must be either CBC or 844"),
  body("level").notEmpty().trim().withMessage("Class level is required"),
  body("stream").optional().trim(),
  body("class_teacher_id")
    .optional()
    .isInt()
    .withMessage("Invalid class teacher ID"),
  body("academic_session_id")
    .isInt()
    .withMessage("Academic session is required"),
  body("block_name").optional().trim(),
  body("room_number").optional().trim(),
  body("capacity")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Capacity must be a positive number"),
  body("schedule_type")
    .isIn(["day-scholar", "boarding"])
    .withMessage("Invalid schedule type"),
];

// Use authentication middleware for all routes
router.use(authenticateToken);

// Get all classes with optional filters
router.get(
  "/",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res, next) => {
    try {
      const { academicSessionId, curriculum_type, level } = req.query;
      console.log(req.body);
      // Get current academic session if not specified
      let currentSessionId = academicSessionId;
      if (!currentSessionId) {
        const sessionResult = await pool.query(
          "SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1"
        );
        if (sessionResult.rows.length > 0) {
          currentSessionId = sessionResult.rows[0].id;
        } else {
          return res.status(404).json({
            success: false,
            error: "No active academic session found",
          });
        }
      }

      // Build query with filters
      let query = `
        SELECT
          c.id,
          c.name,
          c.curriculum_type,
          c.level,
          c.stream,
          c.capacity,
          CONCAT(t.first_name, ' ', t.last_name) as class_teacher,
          (
            SELECT COUNT(*)
            FROM students s
            WHERE s.current_class = c.level AND s.stream = c.stream
          ) as student_count
        FROM classes c
        LEFT JOIN teachers t ON c.class_teacher_id = t.id
        WHERE c.academic_session_id = $1
      `;

      const queryParams = [currentSessionId];
      let paramIndex = 2;

      // Add additional filters if provided
      if (curriculum_type) {
        query += ` AND c.curriculum_type = $${paramIndex}`;
        queryParams.push(curriculum_type);
        paramIndex++;
      }

      if (level) {
        query += ` AND c.level = $${paramIndex}`;
        queryParams.push(level);
        paramIndex++;
      }

      query += " ORDER BY c.level, c.stream";

      const result = await pool.query(query, queryParams);

      res.json({
        success: true,
        count: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      console.error("Error fetching classes:", error);
      next(error);
    }
  }
);

// Get classes by academic session
router.get("/classes-academic-session", async (req, res) => {
  try {
    const { academic_session_id } = req.query;

    if (!academic_session_id) {
      return res
        .status(400)
        .json({ message: "Academic session ID is required" });
    }

    const query = `
      SELECT id, name, level, stream, curriculum_type, capacity
      FROM classes
      WHERE academic_session_id = $1
      ORDER BY level, stream
    `;

    const result = await pool.query(query, [academic_session_id]);
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching classes:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Create new class
router.post(
  "/",
  authorizeRoles("admin"),
  validate(classValidation),
  async (req, res, next) => {
    try {
      const result = await classModel.create(req.body);
      res.status(201).json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

// Update class
router.put(
  "/:id",
  authorizeRoles("admin"),
  validate(classValidation),
  async (req, res, next) => {
    try {
      const result = await classModel.update(req.params.id, req.body);
      if (!result.rows.length) {
        return res.status(404).json({ error: "Class not found" });
      }
      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

// Delete class
router.delete("/:id", authorizeRoles("admin"), async (req, res, next) => {
  try {
    const result = await classModel.delete(req.params.id);
    if (!result.rows.length) {
      return res.status(404).json({ error: "Class not found" });
    }
    res.json({ message: "Class deleted successfully" });
  } catch (error) {
    next(error);
  }
});

// Get students in a class
router.get("/:id/students", async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const result = await classModel.getClassStudents(
      req.params.id,
      page,
      limit
    );
    const total = await classModel.getClassStudentsCount(req.params.id);

    res.json({
      data: result.rows,
      page,
      limit,
      total,
    });
  } catch (error) {
    next(error);
  }
});

// Get class timetable
router.get("/:id/timetable", async (req, res, next) => {
  try {
    const result = await classModel.getClassTimetable(req.params.id);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

// Get class attendance summary
router.get(
  "/:id/attendance-summary",
  query("date").isDate().withMessage("Valid date is required"),
  async (req, res, next) => {
    try {
      const date = new Date(req.query.date);
      const result = await classModel.getAttendanceSummary(req.params.id, date);
      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

// Assign subjects to class
router.post(
  "/:id/subjects",
  authorizeRoles("admin"),
  body("subject_ids").isArray().withMessage("Subject IDs must be an array"),
  body("subject_ids.*").isInt().withMessage("Invalid subject ID"),
  async (req, res, next) => {
    try {
      const result = await classModel.assignSubjects(
        req.params.id,
        req.body.subject_ids
      );
      res.json(result.rows);
    } catch (error) {
      next(error);
    }
  }
);

// Get class subjects
router.get("/:id/subjects", async (req, res, next) => {
  try {
    const result = await classModel.getClassSubjects(req.params.id);
    res.json(result.rows);
  } catch (error) {
    next(error);
  }
});

// Assign class teacher
router.post(
  "/:id/teacher",
  authorizeRoles("admin"),
  body("teacher_id").isInt().withMessage("Valid teacher ID is required"),
  async (req, res, next) => {
    try {
      const result = await classModel.assignClassTeacher(
        req.params.id,
        req.body.teacher_id
      );
      if (!result.rows.length) {
        return res.status(404).json({ error: "Class or teacher not found" });
      }
      res.json(result.rows[0]);
    } catch (error) {
      next(error);
    }
  }
);

router.get(
  "/subjects",
  authorizeRoles("admin", "teacher", "staff"),
  async (req, res, next) => {
    try {
      const { level, curriculum_type, academicSessionId } = req.query;
      console.log("Request query parameters:", req.query);
      
      // Get current academic session if not specified
      let currentSessionId = academicSessionId;
      if (!currentSessionId) {
        const sessionResult = await pool.query(
          "SELECT id FROM academic_sessions WHERE is_current = true LIMIT 1"
        );
        if (sessionResult.rows.length > 0) {
          currentSessionId = sessionResult.rows[0].id;
        } else {
          return res.status(404).json({
            success: false,
            error: "No active academic session found",
          });
        }
      }
      
      let query, queryParams;
      
      if (level && curriculum_type) {
        // Map grade level to curriculum level
        let mappedLevel = level;
        
        if (curriculum_type === 'CBC') {
          // Map CBC grade levels to Upper Primary or Junior Secondary
          if (level.includes('Grade') && parseInt(level.replace('Grade ', '')) <= 6) {
            mappedLevel = 'Upper Primary';
          } else if (level.includes('Grade') && parseInt(level.replace('Grade ', '')) >= 7) {
            mappedLevel = 'Junior Secondary';
          }
          // Map JSS levels to Junior Secondary
          else if (level.includes('JSS')) {
            mappedLevel = 'Junior Secondary';
          }
        } else if (curriculum_type === '844') {
          // Map 844 form levels to Secondary
          if (level.includes('Form')) {
            mappedLevel = 'Secondary';
          }
        }
        
        console.log(`Mapped ${level} to ${mappedLevel} for ${curriculum_type}`);
        
        query = `
          SELECT DISTINCT
            s.id,
            s.name,
            s.code,
            s.curriculum_type,
            s.level,
            s.passing_marks,
            d.name as department_name
          FROM subjects s
          LEFT JOIN departments d ON s.department_id = d.id
          WHERE s.curriculum_type = $1
          AND s.level = $2
          ORDER BY s.name
        `;
        queryParams = [curriculum_type, mappedLevel];
      } else {
        // Get all subjects
        query = `
          SELECT
            s.id,
            s.name,
            s.code,
            s.curriculum_type,
            s.level,
            s.passing_marks,
            d.name as department_name
          FROM subjects s
          LEFT JOIN departments d ON s.department_id = d.id
          ORDER BY s.level, s.name
        `;
        queryParams = [];
      }
      
      console.log("SQL Query:", { text: query, values: queryParams });
      
      const result = await pool.query(query, queryParams);
      console.log("Query result count:", result.rows.length);
      
      res.json({
        success: true,
        count: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      console.error("Error fetching subjects:", error);
      next(error);
    }
  }
);

export default router;
