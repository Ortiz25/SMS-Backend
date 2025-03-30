// src/routes/library.routes.js
import express from "express";
import pool from "../config/database.js";
import { authenticateToken, authorizeRoles } from "../middleware/auth.js";

const router = express.Router();

// Apply authentication middleware
router.use(authenticateToken);

// Get all books
router.get(
  "/books",
  authorizeRoles("admin", "librarian", "teacher", "student"),
  async (req, res, next) => {
    try {
      const query = `
            SELECT 
                lb.id, 
                lb.title, 
                lb.author, 
                lb.isbn, 
                lb.status,
                lb.total_copies,
                bb.borrower_name AS borrower,
                bb.due_date
            FROM library_books lb
            LEFT JOIN book_borrowing bb ON lb.id = bb.book_id AND bb.status = 'borrowed'
            ORDER BY lb.title;
        `;

      const result = await pool.query(query);

      res.json({
        success: true,
        count: result.rows.length,
        data: result.rows,
      });
    } catch (error) {
      console.error("Error fetching books:", error);
      next(error);
    }
  }
);

router.get(
  "/borrowers",
  authorizeRoles("admin", "librarian"),
  async (req, res) => {
    try {
      console.log("Borrowers route");
      // Only allow librarians and admins to access this route
      if (req.user.role !== "librarian" && req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          error:
            "Access denied. Only librarians and administrators can view borrowers.",
        });
      }

      // Query to join book_borrowing with library_books to get complete information
      const query = `
      SELECT 
        bb.id,
        bb.book_id,
        lb.title,
        lb.author,
        lb.isbn,
        bb.borrower_name,
        bb.borrower_type,
        bb.borrower_contact,
        bb.borrow_date,
        bb.due_date,
        bb.status,
        bb.fine_amount,
        bb.fine_paid,
        bb.notes,
        CASE 
          WHEN bb.student_id IS NOT NULL THEN s.first_name || ' ' || s.last_name
          WHEN bb.teacher_id IS NOT NULL THEN t.first_name || ' ' || t.last_name
          ELSE bb.borrower_name
        END as full_name,
        CASE
          WHEN bb.student_id IS NOT NULL THEN s.admission_number
          WHEN bb.teacher_id IS NOT NULL THEN t.staff_id
          ELSE bb.borrower_contact
        END as identifier
      FROM 
        book_borrowing bb
      JOIN 
        library_books lb ON bb.book_id = lb.id
      LEFT JOIN 
        students s ON bb.student_id = s.id
      LEFT JOIN 
        teachers t ON bb.teacher_id = t.id
      WHERE 
        bb.status IN ('borrowed', 'overdue')
      ORDER BY 
        CASE WHEN bb.status = 'overdue' THEN 0 ELSE 1 END,
        bb.due_date ASC
    `;

      const result = await pool.query(query);

      // Format dates for easier frontend consumption
      const borrowers = result.rows.map((row) => ({
        ...row,
        borrow_date: row.borrow_date
          ? new Date(row.borrow_date).toISOString().split("T")[0]
          : null,
        due_date: row.due_date
          ? new Date(row.due_date).toISOString().split("T")[0]
          : null,
        is_overdue: row.due_date && new Date(row.due_date) < new Date(),
      }));

      // Group statistics
      const stats = {
        total: borrowers.length,
        overdue: borrowers.filter((b) => b.status === "overdue").length,
        students: borrowers.filter((b) => b.borrower_type === "student").length,
        teachers: borrowers.filter((b) => b.borrower_type === "teacher").length,
        others: borrowers.filter((b) => b.borrower_type === "other").length,
      };

      return res.status(200).json({
        success: true,
        data: borrowers,
        stats: stats,
      });
    } catch (error) {
      console.error("Error fetching borrowers:", error);
      return res.status(500).json({
        success: false,
        error: "Server error fetching borrowers",
      });
    }
  }
);

/**
 * @route   GET /api/library/borrowers/overdue
 * @desc    Fetch only overdue borrowed books
 * @access  Private (Librarian, Admin)
 */
router.get(
  "/borrowers/overdue",
  authorizeRoles("admin", "librarian"),
  async (req, res) => {
    try {
      // Only allow librarians and admins to access this route
      if (req.user.role !== "librarian" && req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          error:
            "Access denied. Only librarians and administrators can view borrowers.",
        });
      }

      // Query to get only overdue books
      const query = `
      SELECT 
        bb.id,
        bb.book_id,
        lb.title,
        lb.author,
        lb.isbn,
        bb.borrower_name,
        bb.borrower_type,
        bb.borrower_contact,
        bb.borrow_date,
        bb.due_date,
        bb.status,
        bb.fine_amount,
        bb.fine_paid,
        bb.notes,
        CASE 
          WHEN bb.student_id IS NOT NULL THEN s.first_name || ' ' || s.last_name
          WHEN bb.teacher_id IS NOT NULL THEN t.first_name || ' ' || t.last_name
          ELSE bb.borrower_name
        END as full_name,
        CASE
          WHEN bb.student_id IS NOT NULL THEN s.admission_number
          WHEN bb.teacher_id IS NOT NULL THEN t.staff_id
          ELSE bb.borrower_contact
        END as identifier,
        (CURRENT_DATE - bb.due_date) as days_overdue
        FROM 
    book_borrowing bb
  JOIN 
    library_books lb ON bb.book_id = lb.id
  LEFT JOIN 
    students s ON bb.student_id = s.id
  LEFT JOIN 
    teachers t ON bb.teacher_id = t.id
  WHERE 
    (bb.due_date < CURRENT_DATE AND bb.status = 'borrowed')
    OR bb.status = 'overdue'
  ORDER BY 
    bb.due_date ASC
    `;

      const result = await pool.query(query);

      // Update status to 'overdue' for books that are past due date
      // This should normally be handled by a scheduled job, but we'll do it here as well
      if (result.rows.length > 0) {
        const overdueIds = result.rows.map((row) => row.id);
        await pool.query(
          `
        UPDATE book_borrowing 
        SET status = 'overdue', 
            fine_amount = (CURRENT_DATE - due_date) * 20.00 -- KES 20 per day fine as per the schema
        WHERE id = ANY($1)
      `,
          [overdueIds]
        );
      }

      // Format dates for easier frontend consumption
      const overdueBorrowers = result.rows.map((row) => ({
        ...row,
        borrow_date: row.borrow_date
          ? new Date(row.borrow_date).toISOString().split("T")[0]
          : null,
        due_date: row.due_date
          ? new Date(row.due_date).toISOString().split("T")[0]
          : null,
        status: "overdue", // Force status to be overdue
      }));

      return res.status(200).json({
        success: true,
        data: overdueBorrowers,
        count: overdueBorrowers.length,
      });
    } catch (error) {
      console.error("Error fetching overdue borrowers:", error);
      return res.status(500).json({
        success: false,
        error: "Server error fetching overdue borrowers",
      });
    }
  }
);

/**
 * @route   GET /api/library/borrowers/search
 * @desc    Search borrowers by name, book title, or contact
 * @access  Private (Librarian, Admin)
 */
router.get(
  "/borrowers/search",
  authorizeRoles("admin", "librarian"),
  async (req, res) => {
    try {
      // Only allow librarians and admins to access this route
      if (req.user.role !== "librarian" && req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          error:
            "Access denied. Only librarians and administrators can search borrowers.",
        });
      }

      const { search } = req.query;
      if (!search) {
        return res.status(400).json({
          success: false,
          error: "Search term is required",
        });
      }

      // Query to search borrowers
      const query = `
      SELECT 
        bb.id,
        bb.book_id,
        lb.title,
        lb.author,
        lb.isbn,
        bb.borrower_name,
        bb.borrower_type,
        bb.borrower_contact,
        bb.borrow_date,
        bb.due_date,
        bb.status,
        bb.fine_amount,
        bb.fine_paid,
        bb.notes
      FROM 
        book_borrowing bb
      JOIN 
        library_books lb ON bb.book_id = lb.id
      WHERE 
        bb.status IN ('borrowed', 'overdue')
        AND (
          bb.borrower_name ILIKE $1
          OR lb.title ILIKE $1
          OR lb.author ILIKE $1
          OR bb.borrower_contact ILIKE $1
          OR lb.isbn ILIKE $1
        )
      ORDER BY 
        CASE WHEN bb.status = 'overdue' THEN 0 ELSE 1 END,
        bb.due_date ASC
    `;

      const result = await pool.query(query, [`%${search}%`]);

      // Format dates for easier frontend consumption
      const borrowers = result.rows.map((row) => ({
        ...row,
        borrow_date: row.borrow_date
          ? new Date(row.borrow_date).toISOString().split("T")[0]
          : null,
        due_date: row.due_date
          ? new Date(row.due_date).toISOString().split("T")[0]
          : null,
        is_overdue: row.due_date && new Date(row.due_date) < new Date(),
      }));

      return res.status(200).json({
        success: true,
        data: borrowers,
        count: borrowers.length,
      });
    } catch (error) {
      console.error("Error searching borrowers:", error);
      return res.status(500).json({
        success: false,
        error: "Server error searching borrowers",
      });
    }
  }
);

// Get book by ID
router.get(
  "/:id",
  authorizeRoles("admin", "librarian", "teacher", "student"),
  async (req, res, next) => {
    try {
      const bookId = parseInt(req.params.id, 10);

      if (isNaN(bookId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid book ID",
        });
      }

      const query = `
            SELECT 
                lb.*,
                bb.borrower_name AS borrower,
                bb.due_date
            FROM 
                library_books lb
            LEFT JOIN 
                book_borrowing bb ON lb.id = bb.book_id AND bb.status = 'borrowed'
            WHERE 
                lb.id = $1
        `;

      const result = await pool.query(query, [bookId]);

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Book not found",
        });
      }

      res.json({
        success: true,
        data: result.rows[0],
      });
    } catch (error) {
      console.error(`Error fetching book with ID ${req.params.id}:`, error);
      next(error);
    }
  }
);

// Update a book

router.put(
  "/books/:id",
  authorizeRoles("admin", "librarian"),
  async (req, res, next) => {
    try {
      const bookId = parseInt(req.params.id, 10);
      const {
        title,
        author,
        isbn,
        category_id,
        publication_year,
        publisher,
        edition,
        total_copies,
        shelf_location,
        price,
      } = req.body;

      const query = `
      UPDATE library_books 
      SET title = $1, author = $2, isbn = $3, category_id = $4, publication_year = $5, publisher = $6, edition = $7, total_copies = $8, copies_available = $8, shelf_location = $9, price = $10, updated_at = NOW() 
      WHERE id = $11 RETURNING *;
    `;

      const result = await pool.query(query, [
        title,
        author,
        isbn,
        category_id,
        publication_year,
        publisher,
        edition,
        total_copies,
        shelf_location,
        price,
        bookId,
      ]);

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Book not found" });
      }

      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error("Error updating book:", error);
      next(error);
    }
  }
);

// Delete a book
router.delete(
  "/books/:id",
  authorizeRoles("admin", "librarian"),
  async (req, res, next) => {
    try {
      const bookId = parseInt(req.params.id, 10);

      if (isNaN(bookId)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid book ID" });
      }

      const query = `DELETE FROM library_books WHERE id = $1 RETURNING *;`;
      const result = await pool.query(query, [bookId]);

      if (result.rows.length === 0) {
        return res
          .status(404)
          .json({ success: false, error: "Book not found" });
      }

      res.json({ success: true, message: "Book deleted successfully" });
    } catch (error) {
      console.error("Error deleting book:", error);
      next(error);
    }
  }
);

// Create a new book
router.post(
  "/books",
  authorizeRoles("admin", "librarian"),
  async (req, res, next) => {
    try {
      const {
        title,
        author,
        isbn,
        category_id,
        publication_year,
        publisher,
        edition,
        total_copies,
        shelf_location,
        price,
      } = req.body;

      const query = `
        INSERT INTO library_books 
        (title, author, isbn, category_id, publication_year, publisher, edition, copies_available, total_copies, shelf_location, price, status) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'available') 
        RETURNING *;
      `;

      const result = await pool.query(query, [
        title,
        author,
        isbn,
        category_id,
        publication_year,
        publisher,
        edition,
        total_copies,
        total_copies,
        shelf_location,
        price,
      ]);

      res.json({ success: true, data: result.rows[0] });
    } catch (error) {
      console.error("Error adding book:", error);
      next(error);
    }
  }
);

// Route for borrowing a book
router.post('/books/:id/borrow', authenticateToken, async (req, res) => {
  try {
    const bookId = req.params.id;
    const { borrower_name, borrower_type, borrower_contact, borrow_date, due_date } = req.body;

    // Check if the book exists and has available copies
    const bookQuery = await pool.query(
      'SELECT * FROM library_books WHERE id = $1',
      [bookId]
    );

    if (bookQuery.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Book not found' });
    }

    const book = bookQuery.rows[0];
    
    if (book.copies_available <= 0) {
      return res.status(400).json({ success: false, error: 'No copies available for borrowing' });
    }

    // Check if student with the admission number exists
    // This is the new check we're adding
    if (borrower_type === 'student') {
      const studentQuery = await pool.query(
        'SELECT * FROM students WHERE admission_number = $1',
        [borrower_contact]
      );

      if (studentQuery.rows.length === 0) {
        return res.status(404).json({ 
          success: false, 
          error: 'Student with this admission number does not exist' 
        });
      }
    }

    // Proceed with borrowing process
    const borrowQuery = await pool.query(
      `INSERT INTO book_borrowing (
        book_id, 
        borrower_name, 
        borrower_type, 
        borrower_contact, 
        borrow_date, 
        due_date, 
        status, 
        issued_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'borrowed', $7)
      RETURNING *`,
      [
        bookId,
        borrower_name,
        borrower_type,
        borrower_contact,
        borrow_date,
        due_date,
        req.user.id
      ]
    );

    // Update book available copies
    await pool.query(
      'UPDATE library_books SET copies_available = copies_available - 1 WHERE id = $1',
      [bookId]
    );

    res.json({ 
      success: true, 
      message: 'Book borrowed successfully', 
      data: borrowQuery.rows[0] 
    });
  } catch (error) {
    console.error('Error borrowing book:', error);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});


router.post(
  "/books/:id/extend",
  authorizeRoles("admin", "librarian"),
  async (req, res) => {
    try {
      // Only allow librarians and admins to access this route
      if (req.user.role !== "librarian" && req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          error:
            "Access denied. Only librarians and administrators can extend loans.",
        });
      }

      const { id } = req.params;
      const { new_due_date, borrowing_id } = req.body;

      if (!new_due_date) {
        return res.status(400).json({
          success: false,
          error: "New due date is required",
        });
      }

      // Validate the date format
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(new_due_date)) {
        return res.status(400).json({
          success: false,
          error: "Invalid date format. Use YYYY-MM-DD format.",
        });
      }

      // Validate that the new due date is in the future
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const newDueDate = new Date(new_due_date);

      if (newDueDate <= today) {
        return res.status(400).json({
          success: false,
          error: "New due date must be in the future",
        });
      }

      // Find the borrowing record
      let borrowingQuery;
      let borrowingParams;

      if (borrowing_id) {
        // If borrowing_id is provided, use it directly
        borrowingQuery =
          "SELECT * FROM book_borrowing WHERE id = $1 AND book_id = $2 AND status IN ('borrowed', 'overdue')";
        borrowingParams = [borrowing_id, id];
      } else {
        // Otherwise, find the active borrowing record for this book
        borrowingQuery =
          "SELECT * FROM book_borrowing WHERE book_id = $1 AND status IN ('borrowed', 'overdue') ORDER BY due_date ASC LIMIT 1";
        borrowingParams = [id];
      }

      const borrowingResult = await pool.query(borrowingQuery, borrowingParams);

      if (borrowingResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No active borrowing record found for this book",
        });
      }

      const borrowing = borrowingResult.rows[0];

      // Update the borrowing record with the new due date
      const updateQuery = `
        UPDATE book_borrowing
        SET 
          due_date = $1,
          status = 'borrowed',
          fine_amount = 0,
          updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `;

      const result = await pool.query(updateQuery, [
        new_due_date,
        borrowing.id,
      ]);

      if (result.rows.length === 0) {
        return res.status(500).json({
          success: false,
          error: "Failed to extend the loan period",
        });
      }

      // Log the extension
      await pool.query(
        `INSERT INTO communication_logs 
          (sender_id, recipient_type, recipient_phone, message, communication_type, status, delivery_time) 
         VALUES 
          ($1, 'individual', $2, $3, 'system', 'sent', NOW())`,
        [
          req.user.id,
          borrowing.borrower_contact,
          `Loan period for book "${borrowing.book_id}" extended to ${new_due_date}`,
        ]
      );

      return res.status(200).json({
        success: true,
        message: "Loan period extended successfully",
        data: result.rows[0],
      });
    } catch (error) {
      console.error("Error extending loan period:", error);
      return res.status(500).json({
        success: false,
        error: "Server error extending loan period",
      });
    }
  }
);

/**
 * @route   POST /api/library/books/:id/return
 * @desc    Return a borrowed book
 * @access  Private (Librarian, Admin)
 */
router.post(
  "/books/:id/return",
  authorizeRoles("admin", "librarian"),
  async (req, res, next) => {
    try {
      const bookId = parseInt(req.params.id, 10);

      if (isNaN(bookId)) {
        return res.status(400).json({
          success: false,
          error: "Invalid book ID",
        });
      }

      // Check if the book exists
      const checkBookQuery = `SELECT * FROM library_books WHERE id = $1`;
      const bookResult = await pool.query(checkBookQuery, [bookId]);

      if (bookResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: "Book not found",
        });
      }

      // Find the active borrowing record for this book
      const borrowingQuery = `
      SELECT * FROM book_borrowing 
      WHERE book_id = $1 AND status IN ('borrowed', 'overdue')
      ORDER BY id DESC LIMIT 1
    `;
      const borrowingResult = await pool.query(borrowingQuery, [bookId]);

      if (borrowingResult.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: "This book is not currently borrowed",
        });
      }

      const borrowing = borrowingResult.rows[0];

      // Update the borrowing record
      const updateBorrowingQuery = `
      UPDATE book_borrowing
      SET 
        status = 'returned',
        return_date = CURRENT_DATE,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
      await pool.query(updateBorrowingQuery, [borrowing.id]);

      // Update the book's availability
      const updateBookQuery = `
      UPDATE library_books
      SET 
        copies_available = copies_available + 1,
        status = CASE 
          WHEN copies_available + 1 >= total_copies THEN 'available'
          ELSE status
        END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
      const updatedBook = await pool.query(updateBookQuery, [bookId]);

      return res.status(200).json({
        success: true,
        message: "Book returned successfully",
        data: updatedBook.rows[0],
      });
    } catch (error) {
      console.error("Error returning book:", error);
      return res.status(500).json({
        success: false,
        error: "Server error returning book",
      });
    }
  }
);

export default router;
