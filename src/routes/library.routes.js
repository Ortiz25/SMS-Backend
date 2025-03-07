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

router.post("/books/:id/borrow", authorizeRoles("admin", "librarian"), async (req, res, next) => {
    try {
      const bookId = parseInt(req.params.id, 10);
      const { borrower_name, borrower_type, borrower_contact, borrow_date, due_date } = req.body;
  
      // Check if book is available
      const bookQuery = `SELECT copies_available FROM library_books WHERE id = $1;`;
      const bookResult = await pool.query(bookQuery, [bookId]);
  
      if (bookResult.rows.length === 0) {
        return res.status(404).json({ success: false, error: "Book not found" });
      }
  
      if (bookResult.rows[0].copies_available < 1) {
        return res.status(400).json({ success: false, error: "Book is not available for borrowing" });
      }
  
      // Insert into book_borrowing
      const borrowQuery = `
        INSERT INTO book_borrowing (book_id, borrower_name, borrower_type, borrower_contact, borrow_date, due_date, status)
        VALUES ($1, $2, $3, $4, $5, $6, 'borrowed') RETURNING *;
      `;
      await pool.query(borrowQuery, [bookId, borrower_name, borrower_type, borrower_contact, borrow_date, due_date]);
  
      // Update copies_available
      const updateBookQuery = `
        UPDATE library_books 
        SET copies_available = copies_available - 1, status = CASE WHEN copies_available - 1 = 0 THEN 'borrowed' ELSE 'available' END
        WHERE id = $1 RETURNING *;
      `;
      const updatedBook = await pool.query(updateBookQuery, [bookId]);
  
      res.json({ success: true, data: updatedBook.rows[0] });
    } catch (error) {
      console.error("Error borrowing book:", error);
      next(error);
    }
  });
  
  
  

export default router;
