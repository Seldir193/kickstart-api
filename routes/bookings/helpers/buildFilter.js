"use strict";

const { ALLOWED_STATUS } = require("./status");

function buildFilter(query, ownerId) {
  const { q, status, date, includeHoliday } = query || {};

  const filter = {
    owner: ownerId,
  };

  if (String(includeHoliday) !== "1") {
    const excludedProgramPattern =
      /camp|feriencamp|powertraining|power training/i;

    filter.$and = [
      {
        $nor: [
          { offerTitle: { $regex: excludedProgramPattern } },
          { offerType: { $regex: excludedProgramPattern } },
          { message: { $regex: excludedProgramPattern } },
        ],
      },
    ];
  }

  if (status && status !== "all" && ALLOWED_STATUS.includes(String(status))) {
    filter.status = String(status);
  }

  if (date) {
    filter.date = String(date);
  }

  if (q && String(q).trim()) {
    const needle = String(q).trim();
    filter.$or = [
      { firstName: { $regex: needle, $options: "i" } },
      { lastName: { $regex: needle, $options: "i" } },
      { email: { $regex: needle, $options: "i" } },
      { level: { $regex: needle, $options: "i" } },
      { message: { $regex: needle, $options: "i" } },
      { confirmationCode: { $regex: needle, $options: "i" } },
    ];
  }

  return filter;
}

module.exports = { buildFilter };

// //routes\bookings\helpers\buildFilter.js
// "use strict";

// const { ALLOWED_STATUS } = require("./status");

// function buildFilter(query, ownerId) {
//   const { q, status, date, includeHoliday } = query || {};

//   const filter = {
//     owner: ownerId,
//   };

//   if (String(includeHoliday) !== "1") {
//     // const bookingsPageCondition = {
//     //   $or: [
//     //     { source: "admin_booking" },
//     //     { source: { $ne: "online_request" } },
//     //     {
//     //       source: "online_request",
//     //       message: {
//     //         $not: /Programm:\s*(Camp|Powertraining)/i,
//     //       },
//     //     },
//     //   ],
//     // };

//     const excludedProgramPattern =
//       /camp|feriencamp|powertraining|power training/i;

//     const bookingsPageCondition = {
//       $or: [
//         {
//           source: "admin_booking",
//           offerTitle: { $not: excludedProgramPattern },
//           offerType: { $not: excludedProgramPattern },
//         },
//         {
//           source: { $nin: ["online_request", "admin_booking"] },
//         },
//         {
//           source: "online_request",
//           message: {
//             $not: /Programm:\s*(Camp|Powertraining)/i,
//           },
//         },
//       ],
//     };

//     filter.$and = [bookingsPageCondition];
//   }

//   if (status && status !== "all" && ALLOWED_STATUS.includes(String(status))) {
//     filter.status = String(status);
//   }

//   if (date) {
//     filter.date = String(date);
//   }

//   if (q && String(q).trim()) {
//     const needle = String(q).trim();
//     filter.$or = [
//       { firstName: { $regex: needle, $options: "i" } },
//       { lastName: { $regex: needle, $options: "i" } },
//       { email: { $regex: needle, $options: "i" } },
//       { level: { $regex: needle, $options: "i" } },
//       { message: { $regex: needle, $options: "i" } },
//       { confirmationCode: { $regex: needle, $options: "i" } },
//     ];
//   }

//   return filter;
// }

// module.exports = { buildFilter };
