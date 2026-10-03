// The projects that were written into the CV page (public/app.js) before they moved
// into the studio. The studio imports them once; after that the studio is the source.
export const CV_PROJECTS = [
  {
    "title": "טובים",
    "summary": "מערכת עבודה לשדכנים, בעברית ומימין לשמאל: כרטיס מלא לכל מועמד, לוח שעוקב אחרי כל הצעה מהרעיון ועד החתונה, הצעות התאמה אוטומטיות עם ציון והסבר, מצב סיעור מוחות, הקפאת הצעה עד תאריך עם תזכורת, ומאגר משותף בין שדכנים ששומר על פרטיות. סיסמאות מוצפנות ב־scrypt, ו־CI שמריץ בדיקות שרת (מול MongoDB אמיתי) ולקוח על כל push.",
    "tags": [
      "React",
      "TypeScript",
      "Vite",
      "Tailwind",
      "shadcn/ui",
      "Express",
      "Mongoose",
      "MongoDB Atlas",
      "Vitest",
      "Render"
    ],
    "meta": {
      "en": {
        "title": "Tovim",
        "summary": "A Hebrew, right-to-left workspace for matchmakers: a full profile for every single, a board that tracks each proposal from first idea to wedding, automatic match suggestions with a score and an explanation, a brainstorm mode, on-hold proposals that come back with a reminder, and a privacy-safe pool shared between matchmakers. scrypt password hashing, and CI that runs server tests (against a real MongoDB) and client tests on every push.",
        "tag": "Full-stack · Live",
        "note": "Free hosting: the first load takes about half a minute. Demo login: rachel@demo.tovim.example, password demo-password"
      },
      "tag": "Full-Stack · באוויר",
      "note": "שרת חינמי: הטעינה הראשונה לוקחת כחצי דקה. כניסת דמו עם rachel@demo.tovim.example והסיסמה demo-password",
      "image": "/img/tovim.webp",
      "links": [
        {
          "k": "live",
          "href": "https://tovim.onrender.com"
        },
        {
          "k": "code",
          "href": "https://github.com/IzikStar/Tovim2-public"
        }
      ],
      "facts": [],
      "source": {
        "type": "github",
        "repo": "IzikStar/Tovim2-public"
      },
      "cv": {
        "show": true,
        "order": 1
      }
    }
  },
  {
    "title": "מנוע שחמט",
    "summary": "משחק שחמט עם מנוע שכתבתי מאפס: ייצוג לוח ב־bitboards, חיפוש alpha-beta ו־10 רמות קושי (העליונות יכולות לעבור ל־Stockfish). משחקים בדפדפן: ה־jar מרים שרת מקומי וממשק React שמדבר איתו ב־WebSocket, עם premoves, רמזים וסקירת מהלכים. הקוד עובר ריפקטור מתועד בשלבים, כשכל שלב מגובה בבדיקות perft, בדיקות אופי ובדיקות דפדפן.",
    "tags": [
      "Java",
      "Maven",
      "JUnit",
      "React",
      "TypeScript",
      "WebSocket",
      "Playwright"
    ],
    "meta": {
      "en": {
        "title": "Chess engine",
        "summary": "A chess game with an engine written from scratch: bitboards, alpha-beta search and 10 difficulty levels (the top ones can hand off to Stockfish). You play in the browser: the jar starts a local server and a React UI that talks to it over a WebSocket, with premoves, hints and move review. The code is going through a documented, phased refactor, each phase backed by perft, characterization and browser tests.",
        "tag": "Java · Algorithms",
        "note": ""
      },
      "tag": "Java · אלגוריתמים",
      "note": "",
      "image": "/img/chess.webp",
      "links": [
        {
          "k": "code",
          "href": "https://github.com/IzikStar/izik-star-chess-engine"
        }
      ],
      "facts": [],
      "source": {
        "type": "github",
        "repo": "IzikStar/izik-star-chess-engine"
      },
      "cv": {
        "show": true,
        "order": 2
      }
    }
  },
  {
    "title": "סוכן חיפוש עבודה (MCP)",
    "summary": "סוכן לחיפוש עבודה שחשוף כשרת MCP, עם אדם בלולאה: כל פעולה דורשת אישור מחוץ לערוץ. ארכיטקטורה הקסגונלית, כלים מוקלדים ויומן החלטות.",
    "tags": [
      "TypeScript",
      "MCP",
      "Playwright",
      "SQLite"
    ],
    "meta": {
      "en": {
        "title": "LinkedIn agent MCP",
        "summary": "A human-in-the-loop job-search agent exposed as an MCP server: every action needs out-of-band confirmation. Hexagonal architecture, typed tools and a decision log.",
        "tag": "TypeScript · Experimental",
        "note": ""
      },
      "tag": "TypeScript · ניסיוני",
      "note": "",
      "image": "",
      "links": [
        {
          "k": "code",
          "href": "https://github.com/IzikStar/linkedin-agent-mcp"
        }
      ],
      "facts": [
        {
          "he": "בדיקות",
          "en": "Tests",
          "v": "199"
        },
        {
          "he": "כל פעולה",
          "en": "Every action",
          "v": {
            "he": "דורשת אישור",
            "en": "confirmed by a human"
          }
        }
      ],
      "source": {
        "type": "github",
        "repo": "IzikStar/linkedin-agent-mcp"
      },
      "cv": {
        "show": true,
        "order": 3
      }
    }
  },
  {
    "title": "Accellent Collect",
    "summary": "כלי לאיסוף ודירוג הקלטות של אנגלית במבטא ישראלי, לאימון מאמן הגייה מבוסס AI. עובד מקצה לקצה ומשרת משתמשים אמיתיים.",
    "tags": [
      "FastAPI",
      "Python",
      "React",
      "TypeScript",
      "SQLite"
    ],
    "meta": {
      "en": {
        "title": "Accellent Collect",
        "summary": "A tool for crowdsourcing and rating recordings of Israeli-accented English, to train an AI pronunciation coach. Works end to end and serves real users.",
        "tag": "Full-stack · Live",
        "note": ""
      },
      "tag": "Full-Stack · באוויר",
      "note": "",
      "image": "",
      "links": [
        {
          "k": "live",
          "href": "https://collect.accellent.org"
        }
      ],
      "facts": [
        {
          "he": "סטטוס",
          "en": "Status",
          "v": {
            "he": "באוויר",
            "en": "Live"
          }
        },
        {
          "he": "הקוד",
          "en": "Code",
          "v": {
            "he": "פרטי",
            "en": "Private"
          }
        }
      ],
      "source": null,
      "cv": {
        "show": true,
        "order": 4
      }
    }
  },
  {
    "title": "Accellent",
    "summary": "מאמן הגייה מבוסס AI לדוברי עברית: מקליטים משפט בדפדפן, Azure Speech מנקד את ההגייה ברמת הפונמה, ומודל שפה הופך את הציונים להנחיות מעשיות (לשון, שפתיים, הטעמה). זה המוצר ש־Accellent Collect אוסף בשבילו נתונים.",
    "tags": [
      "React",
      "TypeScript",
      "NestJS",
      "Nx",
      "Azure Speech",
      "OpenAI"
    ],
    "meta": {
      "en": {
        "title": "Accellent",
        "summary": "An AI pronunciation coach for Hebrew speakers: record a sentence in the browser, Azure Speech scores it phoneme by phoneme, and an LLM turns the scores into practical coaching (tongue, lips, stress). It is the product Accellent Collect gathers data for.",
        "tag": "AI · In development",
        "note": "Code coming later"
      },
      "tag": "AI · בפיתוח",
      "note": "הקוד יפורסם בהמשך",
      "image": "",
      "links": [],
      "facts": [
        {
          "he": "סטטוס",
          "en": "Status",
          "v": {
            "he": "בפיתוח",
            "en": "In development"
          }
        },
        {
          "he": "צינור",
          "en": "Pipeline",
          "v": {
            "he": "ניקוד פונמות ← אימון במודל שפה",
            "en": "Phoneme scoring → LLM coaching"
          }
        }
      ],
      "source": null,
      "cv": {
        "show": true,
        "order": 5
      }
    }
  },
  {
    "title": "GoldenToasts",
    "summary": "אפליקציה למסורת הרמת הכוסית של צוות: תזמון, הזמנות, אישור מנהל ולוח \"עבריינים\" למי שמבריז. אימות JWT, הרשאות לפי תפקיד, ומונוריפו Nx עם בדיקות ו־CI.",
    "tags": [
      "NestJS",
      "React",
      "PostgreSQL",
      "Sequelize",
      "Redux Toolkit",
      "Nx",
      "Jest"
    ],
    "meta": {
      "en": {
        "title": "GoldenToasts",
        "summary": "An app for a team's toast tradition: scheduling, invites, admin approval and a 'criminals' board for whoever skips. JWT auth, role-based guards, and an Nx monorepo with tests and CI.",
        "tag": "Full-stack · Backend",
        "note": ""
      },
      "tag": "Full-Stack · Backend",
      "note": "",
      "image": "",
      "links": [
        {
          "k": "code",
          "href": "https://github.com/IzikStar/golden-toasts"
        }
      ],
      "facts": [
        {
          "he": "בדיקות יחידה",
          "en": "Unit tests",
          "v": "114"
        },
        {
          "he": "בדיקות e2e",
          "en": "E2E tests",
          "v": "8"
        },
        {
          "he": "CI",
          "en": "CI",
          "v": "GitHub Actions"
        }
      ],
      "source": {
        "type": "github",
        "repo": "IzikStar/golden-toasts"
      },
      "cv": {
        "show": true,
        "order": 6
      }
    }
  },
  {
    "title": "סוליטר",
    "summary": "סוליטר קלונדייק עם היסטוריית undo/redo, רמזים, גרירה, סיום אוטומטי כשכל הקלפים גלויים, אנימציות וסאונד. פרויקט לימודי שבניתי עם חבר לכיתה ב־2024 ושופץ ב־2026.",
    "tags": [
      "React",
      "Vite",
      "Tailwind",
      "react-dnd",
      "GSAP"
    ],
    "meta": {
      "en": {
        "title": "Solitaire",
        "summary": "Klondike solitaire with undo/redo history, hints, drag and drop, auto-finish once every card is face up, animations and sound. A learning project built with a classmate in 2024 and polished in 2026.",
        "tag": "React · 2024",
        "note": ""
      },
      "tag": "React · 2024",
      "note": "",
      "image": "/img/solitaire.webp",
      "links": [
        {
          "k": "playGame",
          "href": "https://itschakasafreactproject.netlify.app/"
        },
        {
          "k": "code",
          "href": "https://github.com/IzikStar/solitaire_0.1"
        }
      ],
      "facts": [],
      "source": {
        "type": "github",
        "repo": "IzikStar/solitaire_0.1"
      },
      "cv": {
        "show": true,
        "order": 7
      }
    }
  },
  {
    "title": "MasterMind",
    "summary": "משחק מאסטרמיינד עם פותר מובנה (minimax של Knuth) שמפצח כל קוד ב־5 ניחושים לכל היותר, רמזים, ומצב שבו המחשב מנחש את הקוד שלכם.",
    "tags": [
      "TypeScript",
      "Vite",
      "Vitest"
    ],
    "meta": {
      "en": {
        "title": "MasterMind",
        "summary": "Mastermind with a built-in solver (Knuth's minimax) that cracks any code in at most 5 guesses, hints, and a mode where the computer guesses your code.",
        "tag": "TypeScript · Algorithms",
        "note": ""
      },
      "tag": "TypeScript · אלגוריתמים",
      "note": "",
      "image": "/img/mastermind.webp",
      "links": [
        {
          "k": "playGame",
          "href": "https://izikstar.github.io/MasterMindTS/"
        },
        {
          "k": "code",
          "href": "https://github.com/IzikStar/MasterMindTS"
        }
      ],
      "facts": [],
      "source": {
        "type": "github",
        "repo": "IzikStar/MasterMindTS"
      },
      "cv": {
        "show": true,
        "order": 8
      }
    }
  }
];
