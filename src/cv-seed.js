// The projects that were written into the old static CV page before they moved
// into the studio. The studio imports them once; after that the studio is the source.
export const CV_PROJECTS = [
  {
    "title": "טובים",
    "summary": "מערכת עבודה לשדכנים, בעברית. לכל מועמד יש כרטיס, כל הצעה עוברת על לוח מהרעיון ועד החתונה, והמערכת מציעה זוגות בעצמה עם ציון והסבר למה. שדכנים יכולים לשתף מועמדים במאגר משותף בלי שם משפחה, טלפון ותמונות, ומועמד יכול להירשם לבד דרך קישור אישי. בדיקות השרת רצות מול MongoDB אמיתי, ויחד עם בדיקות הלקוח הן רצות על כל push.",
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
        "summary": "A Hebrew workspace for matchmakers. Every single gets a profile, every proposal moves across a board from first idea to wedding, and the app suggests matches itself with a score and the reason why. Matchmakers can share singles in a common pool without last names, phone numbers or photos, and a single can sign up alone through a personal link. Server tests run against a real MongoDB, and they run with the client tests on every push.",
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
    "summary": "התחלתי ב־2024 עם משחק שחמט פשוט ב־Java, ומאז הוא רק גדל. המנוע שלי (bitboards, חיפוש alpha-beta, והערכת עמדה עם 499 פרמטרים שכוונו אוטומטית) משחק ב־14 רמות קושי. יש ניתוח משחקים עם Stockfish, וריאנטים כמו Antichess ו־King of the Hill, עורך שבו ממציאים כלים וחוקים חדשים, ומעבדה שמשפרת את המנוע דרך טורנירים בין גרסאות שלו. הממשק ב־React מדבר עם שרת Java.",
    "tags": [
      "Java",
      "Maven",
      "JUnit",
      "React",
      "TypeScript",
      "WebSocket",
      "SQLite",
      "Playwright"
    ],
    "meta": {
      "en": {
        "title": "Chess engine",
        "summary": "Started in 2024 as a simple chess game in Java, and it kept growing. My engine (bitboards, alpha-beta search, and an evaluation with 499 auto-tuned parameters) plays at 14 levels. There is game analysis with Stockfish, variants like Antichess and King of the Hill, an editor for inventing new pieces and rules, and a lab that improves the engine through tournaments between versions of itself. The React UI talks to a Java server.",
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
    "summary": "סוכן AI שעוזר לי לחפש עבודה בלינקדאין, דרך שרת MCP עם 20 כלים. הוא יכול לחפש משרות ולקרוא אותן, אבל כל פעולה אמיתית בחשבון מחכה שאאשר אותה בעצמי בטרמינל עם קוד חד פעמי. את זה אוכף מבנה הקוד, לא הוראות לסוכן. 199 בדיקות ו־13 מסמכי החלטה. ניסוי אישי שהרצתי רק על החשבון שלי.",
    "tags": [
      "TypeScript",
      "Node.js",
      "MCP",
      "Playwright",
      "SQLite",
      "Vitest"
    ],
    "meta": {
      "en": {
        "title": "LinkedIn agent MCP",
        "summary": "An AI agent that helps me look for jobs on LinkedIn, through an MCP server with 20 tools. It can search for jobs and read them, but every real action on the account waits until I confirm it myself in a terminal with a one-time code. The code's structure enforces that, not instructions to the agent. 199 tests and 13 decision records. A personal experiment I only ran on my own account.",
        "tag": "TypeScript · Experimental",
        "note": ""
      },
      "tag": "TypeScript · ניסיוני",
      "note": "",
      "image": "/img/linkedin-agent.webp",
      "links": [
        {
          "k": "code",
          "href": "https://github.com/IzikStar/linkedin-agent-mcp"
        }
      ],
      "facts": [],
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
    "summary": "כלי שבניתי כדי לאסוף נתונים בשביל Accellent. מתנדבים מקליטים חמישה משפטים באנגלית, ומדרגים שאני מאשר מקשיבים לכל הקלטה ונותנים ציון לבהירות ולעוצמת המבטא. הוא באוויר ועובד, עם כניסת מנהל, ייצוא של הנתונים ל־ZIP ובדיקת שמיעה עיוורת שמשווה בין אוזן אנושית לסימונים של Azure.",
    "tags": [
      "FastAPI",
      "Python",
      "React",
      "TypeScript",
      "SQLite",
      "Railway"
    ],
    "meta": {
      "en": {
        "title": "Accellent Collect",
        "summary": "A tool I built to collect data for Accellent. Volunteers record five English sentences, and raters I approve listen to each recording and score its clarity and accent strength. It is live and working, with an admin login, a ZIP export of the data and a blind listening check that compares a human ear with Azure's flags.",
        "tag": "Full-stack · Live",
        "note": ""
      },
      "tag": "Full-Stack · באוויר",
      "note": "",
      "image": "/img/accellent-collect.webp",
      "links": [
        {
          "k": "live",
          "href": "https://collect.accellent.org"
        }
      ],
      "facts": [],
      "source": null,
      "cv": {
        "show": true,
        "order": 4
      }
    }
  },
  {
    "title": "Accellent",
    "summary": "מאמן הגייה באנגלית לדוברי עברית. מקליטים משפט, Azure Speech בודק כל צליל, ומודל שפה מסביר מה לשנות בלשון ובשפתיים. בדרך גיליתי ש־Azure נותן 97 למילה think גם כשאומרים tink, אז בניתי סט מדידה עם שגיאות ידועות ושיניתי את הדרך שבה מסמנים צליל שגוי: הזיהוי עלה מ־78% ל־97%.",
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
        "summary": "A pronunciation coach for Hebrew speakers learning English. You record a sentence, Azure Speech checks every sound, and a language model explains what to change with your tongue and lips. Along the way I found that Azure gives 'think' a 97 even when you say 'tink', so I built a test set with known errors and changed how a wrong sound is flagged: detection went from 78% to 97%.",
        "tag": "AI · In development",
        "note": "Code coming later"
      },
      "tag": "AI · בפיתוח",
      "note": "הקוד יפורסם בהמשך",
      "image": "/img/accellent.webp",
      "links": [],
      "facts": [],
      "source": null,
      "cv": {
        "show": true,
        "order": 5
      }
    }
  },
  {
    "title": "GoldenToasts",
    "summary": "בקבוצה שלנו מי שמקבל קידום או חוגג משהו עושה הרמת כוסית, והאפליקציה הזאת דואגת שזה באמת יקרה. קובעים הרמת כוסית ומזמינים אנשים, מנהל מאשר שהיא התקיימה, ומי שמבריז נכנס ללוח הפושעים. בשרת NestJS ו־PostgreSQL, בלקוח React, עם התחברות ב־JWT, הרשאות לפי תפקיד, ובדיקות יחידה ו־e2e שרצות ב־CI.",
    "tags": [
      "NestJS",
      "React",
      "PostgreSQL",
      "Sequelize",
      "Redux Toolkit",
      "Nx",
      "Jest",
      "GitHub Actions"
    ],
    "meta": {
      "en": {
        "title": "GoldenToasts",
        "summary": "In our group, whoever gets promoted or celebrates something hosts a toast, and this app makes sure it actually happens. You schedule a toast and invite people, an admin confirms it took place, and whoever skips lands on the criminals board. NestJS and PostgreSQL on the server, React on the client, JWT login, role-based permissions, and unit and e2e tests that run in CI.",
        "tag": "Full-stack · Backend",
        "note": ""
      },
      "tag": "Full-Stack · Backend",
      "note": "",
      "image": "/img/goldentoasts.webp",
      "links": [
        {
          "k": "code",
          "href": "https://github.com/IzikStar/golden-toasts"
        }
      ],
      "facts": [],
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
    "summary": "סוליטר קלונדייק שבניתי עם חבר לכיתה ב־2024, כשלמדתי React, ושופץ ב־2026: undo ו־redo, רמזים, גרירה, סיום אוטומטי כשכל הקלפים גלויים, אנימציות וסאונד.",
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
        "summary": "Klondike solitaire I built with a classmate in 2024 while learning React, and polished in 2026: undo and redo, hints, drag and drop, auto-finish once every card is face up, animations and sound.",
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
    "summary": "מאסטרמיינד בדפדפן, עם פותר שמפצח כל קוד בחמישה ניחושים לכל היותר (האלגוריתם של Knuth). אפשר לבקש רמז, או להחליף תפקידים ולתת למחשב לנחש את הקוד שלכם.",
    "tags": [
      "TypeScript",
      "Vite",
      "Vitest"
    ],
    "meta": {
      "en": {
        "title": "MasterMind",
        "summary": "Mastermind in the browser, with a solver that cracks any code in five guesses at most (Knuth's algorithm). You can ask for a hint, or swap roles and let the computer guess your code.",
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
