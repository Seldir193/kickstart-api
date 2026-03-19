//routes\bookingActions.js
"use strict";

const express = require("express");

const {
  creditNotePdfAction,
} = require("./bookingActions/handlers/creditNotePdfAction");

const {
  cancelBookingAction,
} = require("./bookingActions/handlers/cancelBookingAction");
const {
  stornoBookingAction,
} = require("./bookingActions/handlers/stornoBookingAction");
const {
  participationPdfAction,
} = require("./bookingActions/handlers/participationPdfAction");

const {
  cancellationPdfAction,
} = require("./bookingActions/handlers/cancellationPdfAction");
const {
  stornoPdfAction,
} = require("./bookingActions/handlers/stornoPdfAction");
const {
  listInvoicesAction,
} = require("./bookingActions/handlers/listInvoicesAction");

const {
  invoicePdfAction,
} = require("./bookingActions/handlers/invoicePdfAction");
const {
  globalDocumentAliasAction,
} = require("./bookingActions/handlers/globalDocumentAliasAction");

const {
  listCustomerDocumentsAction,
} = require("./bookingActions/handlers/listCustomerDocumentsAction");

const {
  contractPdfAction,
} = require("./bookingActions/handlers/contractPdfAction");

const {
  creditNotePdfByBookingIdAction,
} = require("./bookingActions/handlers/creditNotePdfByBookingIdAction");

const router = express.Router();

router.post("/:cid/bookings/:bid/cancel", cancelBookingAction);
router.post("/:cid/bookings/:bid/storno", stornoBookingAction);

router.get("/:cid/bookings/:bid/participation.pdf", participationPdfAction);
router.get("/:cid/bookings/:bid/cancellation.pdf", cancellationPdfAction);
router.get("/:cid/bookings/:bid/storno.pdf", stornoPdfAction);
router.get("/:cid/bookings/:bid/invoice.pdf", invoicePdfAction);
router.get("/:cid/bookings/:bid/contract.pdf", contractPdfAction);

router.get("/:cid/invoices", listInvoicesAction);

router.get("/bookings/:bid/documents/:type", globalDocumentAliasAction);

router.get("/:cid/documents", listCustomerDocumentsAction);

//router.get("/bookings/:bid/credit-note.pdf", creditNotePdfAction);

router.get("/:cid/bookings/:bid/credit-note.pdf", creditNotePdfAction);

router.get("/bookings/:bid/credit-note.pdf", creditNotePdfByBookingIdAction);

module.exports = router;
