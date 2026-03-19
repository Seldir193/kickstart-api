"use strict";

function hasChildContext(payload) {
  return Boolean(
    payload?.childUid?.trim() ||
    payload?.childBirthDate ||
    payload?.childGender?.trim(),
  );
}

function validate(payload) {
  const errors = {};
  const childContext = hasChildContext(payload);

  if (!payload.firstName?.trim()) errors.firstName = "Required";
  if (!payload.lastName?.trim()) errors.lastName = "Required";

  if (!/^\S+@\S+\.\S+$/.test(payload.email || "")) {
    errors.email = "Invalid email";
  }

  if (!payload.date) errors.date = "Pick a date";

  if (childContext) {
    const age = Number(payload.age);
    if (!age || age < 5 || age > 19) errors.age = "Age 5–19";

    if (!["U8", "U10", "U12", "U14", "U16", "U18"].includes(payload.level)) {
      errors.level = "Invalid level";
    }
  }

  return errors;
}

module.exports = { validate };

// "use strict";

// function validate(payload) {
//   const errors = {};
//   if (!payload.firstName?.trim()) errors.firstName = "Required";
//   if (!payload.lastName?.trim()) errors.lastName = "Required";
//   if (!/^\S+@\S+\.\S+$/.test(payload.email || ""))
//     errors.email = "Invalid email";
//   const age = Number(payload.age);
//   if (!age || age < 5 || age > 19) errors.age = "Age 5–19";
//   if (!payload.date) errors.date = "Pick a date";
//   if (!["U8", "U10", "U12", "U14", "U16", "U18"].includes(payload.level))
//     errors.level = "Invalid level";
//   return errors;
// }

// module.exports = { validate };
