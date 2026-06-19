/* ============================================================================
   VELLUM — JOURNALING PROMPTS
   ----------------------------------------------------------------------------
   This is the ONE place to edit your prompts. Add, remove, or change anything.

   HOW IT WORKS
   - "categories" is the list of buttons shown at the top of the prompt panel.
       key   = a short id (letters only, no spaces). Must match a key in "prompts".
       label = the words shown on the button.
   - "prompts" holds the actual prompts, grouped by the same key.

   TO ADD A PROMPT: find the category and add a new line in quotes, ending in a
   comma. Example:
       reflection: [
         "What surprised you about today?",
         "My brand new prompt goes here.",     <-- add lines like this
       ],

   TO ADD A WHOLE NEW CATEGORY:
     1) add a line to "categories", e.g.  { key: "evening", label: "Evening" },
     2) add a matching block to "prompts", e.g.  evening: [ "First prompt." ],
   ============================================================================ */

window.VELLUM_PROMPTS = {
  categories: [
    { key: "reflection", label: "Reflection" },
    { key: "gratitude",  label: "Gratitude" },
    { key: "hard",       label: "Processing a hard day" },
    { key: "ahead",      label: "Looking ahead" }
  ],

  prompts: {
    reflection: [
      "What surprised you about today?",
      "Which moment would you live again, exactly as it was?",
      "What did you notice today that you usually walk right past?",
      "Where did you feel most like yourself?"
    ],
    gratitude: [
      "Name three small things that went right today.",
      "Who made today a little lighter, and how?",
      "What ordinary comfort would you miss most if it were gone?",
      "What is your body letting you do today that you are thankful for?"
    ],
    hard: [
      "Tell what happened plainly, without judging any of it.",
      "What do you need right now that you have not asked for?",
      "If a friend felt exactly this way, what would you say to them?",
      "Where in your body are you carrying today?"
    ],
    ahead: [
      "What are you quietly hoping for this week?",
      "What is one small thing future-you will thank you for?",
      "What would make tomorrow feel like enough?",
      "What are you slowly walking toward right now?"
    ]
  }
};
