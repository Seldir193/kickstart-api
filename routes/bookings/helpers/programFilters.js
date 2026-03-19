"use strict";

// ProgramFilter-Keys aus dem Frontend
const PROGRAM_FILTERS = [
  "weekly_foerdertraining",
  "weekly_kindergarten",
  "weekly_goalkeeper",
  "weekly_development_athletik",
  "ind_1to1",
  "ind_1to1_athletik",
  "ind_1to1_goalkeeper",
  "club_rentacoach",
  "club_trainingcamps",
  "club_coacheducation",
];

// Mapping: ProgramFilter -> Offer-Query
function buildOfferFilterForProgram(programKey) {
  switch (programKey) {
    // ==== Weekly Courses ====
    case "weekly_foerdertraining":
      return { category: "Weekly", type: "Foerdertraining" };

    case "weekly_kindergarten":
      return { category: "Weekly", type: "Kindergarten" };

    case "weekly_goalkeeper":
      // Torwarttraining als Weekly-Kurs
      return { category: "Weekly", sub_type: "Torwarttraining" };

    case "weekly_development_athletik":
      // dein DB-Wert: Foerdertraining_Athletik
      return { category: "Weekly", sub_type: "Foerdertraining_Athletik" };

    // ==== Individual Courses ====
    case "ind_1to1":
      // "normales" PersonalTraining ohne spezielles sub_type
      return { category: "Individual", type: "PersonalTraining", sub_type: "" };

    case "ind_1to1_athletik":
      return {
        category: "Individual",
        sub_type: "Einzeltraining_Athletik",
      };

    case "ind_1to1_goalkeeper":
      return {
        category: "Individual",
        sub_type: "Einzeltraining_Torwart",
      };

    // ==== Club Programs ====
    case "club_rentacoach":
      // Kategorie RentACoach mit Generic-Subtyp
      return {
        category: "RentACoach",
        sub_type: "RentACoach_Generic",
      };

    case "club_trainingcamps":
      // generische Club-Programme (Training Camps)
      return {
        category: "ClubPrograms",
        sub_type: "ClubProgram_Generic",
      };

    case "club_coacheducation":
      return {
        category: "ClubPrograms",
        sub_type: "CoachEducation",
      };

    default:
      return null;
  }
}

module.exports = {
  PROGRAM_FILTERS,
  buildOfferFilterForProgram,
};
