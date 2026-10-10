import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SIMULATION_DATE = "2026-10-10";
const SYNTHETIC_LABEL = "SYNTHETIC";

const SUBJECTS = [
  { en: "external corrosion review", th: "การทบทวนการกัดกร่อนภายนอก" },
  { en: "coating condition review", th: "การทบทวนสภาพสารเคลือบ" },
  { en: "cathodic protection review", th: "การทบทวนระบบป้องกันการกัดกร่อนแบบแคโทดิก" },
  { en: "ILI feature assessment", th: "การประเมินข้อบ่งชี้จากการตรวจสอบภายในท่อ" },
  { en: "right-of-way observation", th: "ข้อสังเกตจากการตรวจแนวเขตทาง" },
  { en: "marker and signage inspection", th: "การตรวจป้ายและหลักแสดงแนวท่อ" },
  { en: "valve-station readiness", th: "ความพร้อมของสถานีวาล์ว" },
  { en: "repair-work preparation", th: "การเตรียมงานซ่อมบำรุง" },
  { en: "inspection record quality", th: "คุณภาพบันทึกการตรวจสอบ" },
  { en: "maintenance handover", th: "การส่งมอบงานบำรุงรักษา" },
  { en: "evidence traceability", th: "การตรวจสอบย้อนกลับของหลักฐาน" },
  { en: "management review", th: "การทบทวนโดยฝ่ายบริหาร" },
];

const DOCUMENT_TYPES = [
  {
    code: "PROC",
    key: "procedure",
    folder: "Pipeline Integrity/Procedures",
    title: { en: "Synthetic work procedure", th: "ระเบียบปฏิบัติงานจำลอง" },
    sections: {
      en: [
        ["Purpose", "Describe a controlled review workflow for the stated synthetic topic."],
        ["Responsibilities", "A qualified reviewer checks the source record, scope, and required controls before work is planned. A second person records the review outcome."],
        ["Procedure", "Confirm the document revision. Compare the proposed activity with the approved work scope. Record evidence and unresolved questions. Stop and escalate if the source, location, or authorization is unclear."],
        ["Records", "Retain the review record, supporting references, and any follow-up request under the applicable document-control process."],
      ],
      th: [
        ["วัตถุประสงค์", "กำหนดขั้นตอนการทบทวนแบบควบคุมสำหรับหัวข้อจำลองที่ระบุ"],
        ["หน้าที่รับผิดชอบ", "ผู้ทบทวนที่มีคุณสมบัติตรวจสอบแหล่งข้อมูล ขอบเขต และมาตรการควบคุมก่อนวางแผนงาน บุคคลอีกคนบันทึกผลการทบทวน"],
        ["ขั้นตอนปฏิบัติ", "ยืนยัน revision ของเอกสาร เปรียบเทียบกิจกรรมที่เสนอ กับขอบเขตงานที่อนุมัติ บันทึกหลักฐานและคำถามที่ยังไม่ยุติ ให้หยุดและยกระดับเมื่อแหล่งข้อมูล ตำแหน่ง หรือการอนุมัติไม่ชัดเจน"],
        ["บันทึก", "เก็บบันทึกการทบทวน เอกสารอ้างอิงประกอบ และคำขอติดตามผลตามกระบวนการควบคุมเอกสารที่เกี่ยวข้อง"],
      ],
    },
  },
  {
    code: "ILI",
    key: "ili-report",
    folder: "Pipeline Integrity/Inspection/ILI",
    title: { en: "Synthetic ILI report", th: "รายงาน ILI จำลอง" },
    sections: {
      en: [
        ["Scope", "This fictional report describes a sample review of an in-line inspection record for DL-01. It is not an engineering assessment."],
        ["Record summary", "The sample record contains SYNTHETIC indications and placeholder measurements. No real inspection run or pipeline measurement is represented."],
        ["Review notes", "A qualified integrity engineer should verify the source file, tool configuration, sizing basis, and any required validation before interpreting an indication."],
        ["Limitations", "This candidate document must not be used to make a fitness-for-service, repair, pressure, or return-to-service decision."],
      ],
      th: [
        ["ขอบเขต", "รายงานสมมตินี้อธิบายตัวอย่างการทบทวนบันทึกการตรวจสอบภายในท่อของ DL-01 ไม่ใช่การประเมินทางวิศวกรรม"],
        ["สรุปบันทึก", "บันทึกตัวอย่างมีข้อบ่งชี้และค่าการวัดตัวอย่างที่ติดป้าย SYNTHETIC ไม่มีการตรวจจริงหรือการวัดท่อจริงรวมอยู่"],
        ["ข้อสังเกตในการทบทวน", "วิศวกรความสมบูรณ์ที่มีคุณสมบัติควรตรวจสอบไฟล์ต้นทาง การตั้งค่าเครื่องมือ หลักการกำหนดขนาด และการยืนยันผลที่จำเป็นก่อนแปลผลข้อบ่งชี้"],
        ["ข้อจำกัด", "ห้ามใช้เอกสาร candidate นี้เพื่อตัดสินความเหมาะสมต่อการใช้งาน การซ่อมแซม แรงดัน หรือการกลับเข้าปฏิบัติงาน"],
      ],
    },
  },
  {
    code: "PATROL",
    key: "patrol-log",
    folder: "Pipeline Integrity/Inspection/Patrol",
    title: { en: "Synthetic patrol log", th: "บันทึกการตรวจแนวท่อจำลอง" },
    sections: {
      en: [
        ["Patrol scope", "A fictional patrol entry for the DL-01 demonstration set. The entry does not identify a real route or operator."],
        ["Observation", "SYNTHETIC observation: [describe a fictional condition]. Location reference: [SYNTHETIC LOCATION]."],
        ["Immediate response", "No field response is represented. A qualified person must assess any real observation and use the Organisation's approved response process."],
        ["Follow-up", "Record the source, review decision, and any request for further inspection. Keep unverified observations separate from accepted Evidence."],
      ],
      th: [
        ["ขอบเขตการตรวจ", "รายการตรวจแนวท่อสมมติสำหรับชุดสาธิต DL-01 โดยไม่ระบุเส้นทางหรือผู้ประกอบการจริง"],
        ["ข้อสังเกต", "ข้อสังเกตจำลอง: [อธิบายสภาพสมมติ] ตำแหน่งอ้างอิง: [ตำแหน่งจำลอง]"],
        ["การตอบสนองทันที", "ไม่มีการตอบสนองภาคสนามจริง ผู้มีคุณสมบัติต้องประเมินข้อสังเกตจริงและใช้กระบวนการตอบสนองที่ Organisation อนุมัติ"],
        ["การติดตามผล", "บันทึกแหล่งข้อมูล ผลการทบทวน และคำขอตรวจสอบเพิ่มเติม แยกข้อสังเกตที่ยังไม่ยืนยันออกจาก Evidence ที่ยอมรับแล้ว"],
      ],
    },
  },
  {
    code: "RCA",
    key: "root-cause-analysis",
    folder: "Pipeline Integrity/Incidents/RCA",
    title: { en: "Synthetic root-cause analysis", th: "รายงานวิเคราะห์สาเหตุรากจำลอง" },
    sections: {
      en: [
        ["Event summary", "This is a fictional learning scenario. No incident, injury, release, or asset damage occurred."],
        ["Evidence reviewed", "The sample review uses placeholder records marked SYNTHETIC. Missing or conflicting evidence is listed as an open question, not treated as fact."],
        ["Cause analysis", "Candidate contributing factors are hypotheses for human review. The document does not assign fault or establish a final cause."],
        ["Actions for review", "A responsible reviewer may propose follow-up questions or preventive learning. No action is approved or sent to a system of record by this document."],
      ],
      th: [
        ["สรุปเหตุการณ์", "นี่คือสถานการณ์เรียนรู้สมมติ ไม่มีเหตุการณ์ การบาดเจ็บ การรั่วไหล หรือความเสียหายต่อ Asset เกิดขึ้นจริง"],
        ["หลักฐานที่ทบทวน", "ตัวอย่างใช้บันทึก placeholder ที่ติดป้าย SYNTHETIC หลักฐานที่ขาดหรือขัดแย้งจะระบุเป็นคำถามเปิด ไม่ถือเป็นข้อเท็จจริง"],
        ["การวิเคราะห์สาเหตุ", "ปัจจัยที่อาจเกี่ยวข้องเป็นสมมติฐานสำหรับ human review เอกสารนี้ไม่ระบุความผิดหรือยืนยันสาเหตุสุดท้าย"],
        ["การดำเนินการเพื่อทบทวน", "ผู้ทบทวนอาจเสนอคำถามติดตามหรือบทเรียนป้องกันได้ เอกสารนี้ไม่ได้อนุมัติหรือส่งการดำเนินการไปยังระบบบันทึกหลัก"],
      ],
    },
  },
  {
    code: "MEMO",
    key: "memo",
    folder: "Pipeline Integrity/Engineering/Memos",
    title: { en: "Synthetic engineering memo", th: "บันทึกวิศวกรรมจำลอง" },
    sections: {
      en: [
        ["Purpose", "Summarise the status of a fictional document review for a demonstration audience."],
        ["Context", "All asset references and observations are fictional and labelled SYNTHETIC. This memo is not a technical authority decision."],
        ["Review requested", "Please verify the source, revision, assumptions, and limitations before accepting any statement as Evidence."],
        ["Disposition", "Draft for human review. No approval, repair instruction, operating limit, or external submission is created by this memo."],
      ],
      th: [
        ["วัตถุประสงค์", "สรุปสถานะการทบทวนเอกสารสมมติสำหรับผู้ชมการสาธิต"],
        ["บริบท", "การอ้างถึง Asset และข้อสังเกตทั้งหมดเป็นข้อมูลสมมติและติดป้าย SYNTHETIC บันทึกนี้ไม่ใช่คำวินิจฉัยของ Technical Authority"],
        ["คำขอทบทวน", "โปรดยืนยันแหล่งข้อมูล revision สมมติฐาน และข้อจำกัดก่อนยอมรับข้อความใดเป็น Evidence"],
        ["สถานะ", "ร่างเพื่อ human review บันทึกนี้ไม่ได้สร้างการอนุมัติ คำสั่งซ่อม ขีดจำกัดการเดินระบบ หรือการยื่นเอกสารภายนอก"],
      ],
    },
  },
];

function escapeYaml(value) {
  return JSON.stringify(value);
}

function filenameFor(documentId) {
  return `${documentId.toLowerCase()}.md`;
}

function renderDocument(metadata, type, subject, language) {
  const title = `${type.title[language]}: ${subject[language]}`;
  const sections = type.sections[language]
    .map(([heading, content]) => `## ${heading}\n\n${content}`)
    .join("\n\n");
  const metadataLines = [
    ["document_id", metadata.documentId],
    ["title", title],
    ["document_type", metadata.documentType],
    ["language", metadata.language],
    ["revision", metadata.revision],
    ["status", metadata.status],
    ["review_status", metadata.reviewStatus],
    ["folder", metadata.folder],
    ["classification", metadata.classification],
    ["licence", metadata.licence],
    ["simulated", metadata.simulated],
    ["label", metadata.label],
    ["recorded_on", SIMULATION_DATE],
    ["supersedes", metadata.supersedes],
    ["superseded_by", metadata.supersededBy],
  ]
    .map(([key, value]) => `${key}: ${typeof value === "boolean" ? value : escapeYaml(value)}`)
    .join("\n");

  return `---\n${metadataLines}\n---\n\n# ${title}\n\n> ${SYNTHETIC_LABEL} — Candidate document for demonstration only. Human review is pending.\n\n${sections}\n\n## Document control\n\n- Revision: ${metadata.revision}\n- Status: ${metadata.status}\n- Recorded on: ${SIMULATION_DATE} (synthetic record date)\n- Review: pending human review\n- All identifiers, observations, and values in this document are fictional. No field activity occurred.\n`;
}

export function validateDocument(document) {
  const { metadata, content } = document;
  const requiredStrings = [
    "documentId",
    "title",
    "documentType",
    "language",
    "revision",
    "status",
    "reviewStatus",
    "folder",
    "classification",
    "licence",
  ];
  for (const field of requiredStrings) {
    if (typeof metadata[field] !== "string" || metadata[field].trim() === "") {
      throw new Error(`Synthetic corpus document requires metadata.${field}.`);
    }
  }
  if (metadata.label !== SYNTHETIC_LABEL || metadata.simulated !== true) {
    throw new Error("Synthetic corpus documents must be labelled SYNTHETIC and simulated.");
  }
  if (metadata.reviewStatus !== "pending") {
    throw new Error("Synthetic corpus documents must remain pending human review.");
  }
  if (!new Set(["en", "th"]).has(metadata.language)) {
    throw new Error(`Unsupported corpus language: ${metadata.language}.`);
  }
  if (metadata.status !== "draft") {
    throw new Error("Unreviewed synthetic corpus documents must have draft status.");
  }
  if (typeof content !== "string" || !content.includes(SYNTHETIC_LABEL)) {
    throw new Error("Synthetic corpus document content must include the SYNTHETIC label.");
  }
  return document;
}

export function buildCorpus() {
  const documents = [];
  for (const type of DOCUMENT_TYPES) {
    for (const language of ["en", "th"]) {
      SUBJECTS.forEach((subject, subjectIndex) => {
        const seriesId = `SYN-UC1-${type.code}-${language.toUpperCase()}-${String(subjectIndex + 1).padStart(3, "0")}`;
        for (const revision of ["A", "B"]) {
          const documentId = `${seriesId}-${revision}`;
          const title = `${type.title[language]}: ${subject[language]}`;
          const metadata = {
            documentId,
            title,
            documentType: type.key,
            language,
            revision,
            status: "draft",
            reviewStatus: "pending",
            folder: type.folder,
            classification: "internal",
            licence: "synthetic",
            simulated: true,
            label: SYNTHETIC_LABEL,
            supersedes: revision === "B" ? `${seriesId}-A` : null,
            supersededBy: revision === "A" ? `${seriesId}-B` : null,
          };
          const document = {
            metadata,
            filename: filenameFor(documentId),
            content: renderDocument(metadata, type, subject, language),
          };
          validateDocument(document);
          documents.push(document);
        }
      });
    }
  }

  const ids = new Set(documents.map(({ metadata }) => metadata.documentId));
  if (ids.size !== documents.length) {
    throw new Error("Synthetic corpus generator produced duplicate document IDs.");
  }
  if (documents.length < 200 || documents.length > 300) {
    throw new Error(`Synthetic corpus must contain 200–300 documents; got ${documents.length}.`);
  }

  const manifest = {
    schemaVersion: 1,
    generatedBy: "data/synthetic/corpus/generate.mjs",
    recordedOn: SIMULATION_DATE,
    label: SYNTHETIC_LABEL,
    reviewStatus: "pending human review",
    documentCount: documents.length,
    documents: documents.map(({ metadata, filename }) => ({
      ...metadata,
      contentPath: `documents/${filename}`,
    })),
  };

  const checklistHeader = [
    "document_id",
    "title",
    "language",
    "document_type",
    "revision",
    "folder",
    "reviewer",
    "decision",
    "reviewed_at",
    "notes",
  ];
  const checklist = [
    checklistHeader,
    ...documents.map(({ metadata }) => [
      metadata.documentId,
      metadata.title,
      metadata.language,
      metadata.documentType,
      metadata.revision,
      metadata.folder,
      "",
      "",
      "",
      "",
    ]),
  ]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");

  return { documents, manifest, checklist: `${checklist}\n` };
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replaceAll('"', '""')}"`;
}

export async function writeCorpus(outputDir = DEFAULT_OUTPUT_DIR) {
  const outputPath = resolve(outputDir);
  const { documents, manifest, checklist } = buildCorpus();
  await mkdir(resolve(outputPath, "documents"), { recursive: true });
  await Promise.all(
    documents.map(({ filename, content }) =>
      writeFile(resolve(outputPath, "documents", filename), content, "utf8"),
    ),
  );
  await Promise.all([
    writeFile(resolve(outputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(resolve(outputPath, "review-checklist.csv"), checklist, "utf8"),
  ]);
  return manifest;
}

function outputDirectoryFromArgs(args) {
  const outputIndex = args.indexOf("--output-dir");
  if (outputIndex === -1) {
    if (args.length > 0) {
      throw new Error(`Unknown argument: ${args[0]}`);
    }
    return DEFAULT_OUTPUT_DIR;
  }
  if (args.length !== 2 || outputIndex !== 0 || !args[1]) {
    throw new Error("Usage: node generate.mjs [--output-dir <path>]");
  }
  return resolve(args[1]);
}

async function main() {
  const outputDir = outputDirectoryFromArgs(process.argv.slice(2));
  const manifest = await writeCorpus(outputDir);
  process.stdout.write(`Generated ${manifest.documentCount} synthetic candidate documents in ${outputDir}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
