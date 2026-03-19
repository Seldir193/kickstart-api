"use strict";

const mongoose = require("mongoose");

const CoachSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    name: { type: String, default: "" },
    position: { type: String, default: "Trainer" },
    degree: { type: String, default: "" },
    since: { type: String, default: "" },
    dfbLicense: { type: String, default: "" },
    mfsLicense: { type: String, default: "" },
    favClub: { type: String, default: "" },
    favCoach: { type: String, default: "" },
    favTrick: { type: String, default: "" },
    photoUrl: { type: String, default: "" },

    providerId: { type: String, default: "", index: true },

    published: { type: Boolean, default: false, index: true },

    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    rejectionReason: { type: String, default: "" },

    submittedAt: { type: Date, default: null, index: true },

    approvedAt: { type: Date, default: null, index: true },
    liveUpdatedAt: { type: Date, default: null, index: true },
    draftUpdatedAt: { type: Date, default: null, index: true },
    rejectedAt: { type: Date, default: null, index: true },

    hasDraft: { type: Boolean, default: false, index: true },
    draft: { type: Object, default: {} },

    lastProviderEditAt: { type: Date, default: null },
    lastSuperEditAt: { type: Date, default: null },

    lastChangeSummary: { type: String, default: "" },
    lastChangeAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

CoachSchema.index({ slug: 1 }, { unique: true });

CoachSchema.index({
  name: "text",
  firstName: "text",
  lastName: "text",
  position: "text",
});

CoachSchema.index({ createdAt: -1, _id: -1 });
CoachSchema.index({ providerId: 1, createdAt: -1, _id: -1 });
CoachSchema.index({ status: 1, createdAt: -1, _id: -1 });
CoachSchema.index({ providerId: 1, status: 1, createdAt: -1, _id: -1 });

CoachSchema.index({ lastName: 1, firstName: 1, _id: 1 });
CoachSchema.index({ providerId: 1, lastName: 1, firstName: 1, _id: 1 });
CoachSchema.index({ status: 1, lastName: 1, firstName: 1, _id: 1 });
CoachSchema.index({
  providerId: 1,
  status: 1,
  lastName: 1,
  firstName: 1,
  _id: 1,
});

module.exports = mongoose.models.Coach || mongoose.model("Coach", CoachSchema);

// // models/Coach.js
// "use strict";

// const mongoose = require("mongoose");

// const CoachSchema = new mongoose.Schema(
//   {
//     slug: {
//       type: String,
//       required: true,
//       unique: true,
//       lowercase: true,
//       trim: true,
//     },

//     firstName: { type: String, default: "" },
//     lastName: { type: String, default: "" },
//     name: { type: String, default: "" },
//     position: { type: String, default: "Trainer" },
//     degree: { type: String, default: "" },
//     since: { type: String, default: "" },
//     dfbLicense: { type: String, default: "" },
//     mfsLicense: { type: String, default: "" },
//     favClub: { type: String, default: "" },
//     favCoach: { type: String, default: "" },
//     favTrick: { type: String, default: "" },
//     photoUrl: { type: String, default: "" },

//     providerId: { type: String, default: "", index: true },

//     published: { type: Boolean, default: true, index: true },

//     status: {
//       type: String,
//       enum: ["pending", "approved", "rejected"],
//       default: "approved",
//       index: true,
//     },
//     rejectionReason: { type: String, default: "" },

//     submittedAt: { type: Date, default: null, index: true },

//     approvedAt: { type: Date, default: null, index: true },
//     liveUpdatedAt: { type: Date, default: null, index: true },
//     draftUpdatedAt: { type: Date, default: null, index: true },
//     rejectedAt: { type: Date, default: null, index: true },

//     hasDraft: { type: Boolean, default: false, index: true },
//     draft: { type: Object, default: {} },

//     lastProviderEditAt: { type: Date, default: null },
//     lastSuperEditAt: { type: Date, default: null },

//     lastChangeSummary: { type: String, default: "" },
//     lastChangeAt: { type: Date, default: null, index: true },
//   },
//   { timestamps: true },
// );

// CoachSchema.index({ slug: 1 }, { unique: true });
// CoachSchema.index({
//   name: "text",
//   firstName: "text",
//   lastName: "text",
//   position: "text",
// });

// module.exports = mongoose.models.Coach || mongoose.model("Coach", CoachSchema);
