// routes/adminFranchiseLocations/logic.js
"use strict";

const { wrapHandler } = require("./shared");
const { handleGet } = require("./get");
const { handleCreate } = require("./create");
const { handlePatch } = require("./patch");
const { handleDelete } = require("./delete");

module.exports = {
  handleGet: wrapHandler(handleGet),
  handleCreate: wrapHandler(handleCreate),
  handlePatch: wrapHandler(handlePatch),
  handleDelete: wrapHandler(handleDelete),
};
