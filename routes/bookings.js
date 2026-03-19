//routes\bookings.js
"use strict";

const express = require("express");
const adminAuth = require("../middleware/adminAuth");

const router = express.Router();

const { confirmBooking } = require("./bookings/handlers/confirmBooking");
const { createBooking } = require("./bookings/handlers/createBooking");
const { listBookings } = require("./bookings/handlers/listBookings");
const {
  updateBookingStatus,
} = require("./bookings/handlers/updateBookingStatus");

const { softDeleteBooking } = require("./bookings/handlers/softDeleteBooking");
const { restoreBooking } = require("./bookings/handlers/restoreBooking");
const { hardDeleteBooking } = require("./bookings/handlers/hardDeleteBooking");
const {
  cancelConfirmedBooking,
} = require("./bookings/handlers/cancelConfirmedBooking");

const { approvePayment } = require("./bookings/handlers/approvePayment");

const { refundOneTime } = require("./bookings/handlers/refundOneTime");
const { withdrawWeekly } = require("./bookings/handlers/withdrawWeekly");

const { getBookingDetails } = require("./bookings/handlers/getBookingDetails");

const { revokeBooking } = require("./bookings/handlers/revokeBooking");
router.post("/:id/revoke", revokeBooking);

router.post("/:id/refund", adminAuth, refundOneTime);
router.post("/:id/withdraw", adminAuth, withdrawWeekly);

const { weeklyApprove } = require("./bookings/handlers/weeklyApprove");
router.post("/:id/weekly-approve", adminAuth, weeklyApprove);

router.post("/:id/confirm", adminAuth, confirmBooking);
router.post("/", createBooking);

router.get("/", adminAuth, listBookings);
router.patch("/:id/status", adminAuth, updateBookingStatus);

router.delete("/:id", adminAuth, softDeleteBooking);
router.post("/:id/restore", adminAuth, restoreBooking);
router.delete("/:id/hard", adminAuth, hardDeleteBooking);

router.post("/:id/cancel-confirmed", adminAuth, cancelConfirmedBooking);

router.post("/:id/approve-payment", adminAuth, approvePayment);

router.get("/:id", adminAuth, getBookingDetails);

module.exports = router;
