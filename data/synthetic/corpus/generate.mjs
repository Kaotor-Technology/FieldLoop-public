import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL(".", import.meta.url));
const SYNTHETIC_RECORD_DATE = "2026-10-10";
const SYNTHETIC_LABEL = "SYNTHETIC";
const ASSET_CODE = "DL-01";
const LANGUAGES = ["en", "th"];
const REVISIONS = ["A", "B"];
const REVIEW_PENDING = "pending";
const REVIEW_PASSED = "passed";
const DECISION_PASS = "pass";
const DECISION_FAIL = "fail";
const CHECKLIST_HEADER = [
  "document_id",
  "title",
  "language",
  "document_type",
  "revision",
  "folder",
  "review_hash",
  "reviewer",
  "decision",
  "reviewed_at",
  "notes",
];

const ORGANISATION = {
  en: "FieldLoop Demo Pipeline Co. (a fictional company)",
  th: "บริษัท ฟิลด์ลูป เดโม ไปป์ไลน์ จำกัด (บริษัทสมมติ)",
};

// Each subject supplies the phrases that the document-type templates combine,
// so every series describes a different fictional review.
const SUBJECTS = [
  {
    en: {
      name: "external corrosion review",
      focus: "external metal loss on buried pipe",
      evidence: "the coating survey record and pipe-to-soil potential readings",
      condition: "surface rust at a coating defect on an exposed girth weld",
    },
    th: {
      name: "การทบทวนการกัดกร่อนภายนอก",
      focus: "การสูญเสียเนื้อโลหะภายนอกของท่อฝังดิน",
      evidence: "บันทึกการสำรวจสารเคลือบและค่าศักย์ท่อเทียบดิน",
      condition: "สนิมผิวที่จุดบกพร่องของสารเคลือบบริเวณรอยเชื่อมรอบท่อที่เปิดหน้าดิน",
    },
  },
  {
    en: {
      name: "coating condition review",
      focus: "coating adhesion and damage along the Segment",
      evidence: "the coating survey record and dig-site photographs",
      condition: "disbonded coating at a field joint",
    },
    th: {
      name: "การทบทวนสภาพสารเคลือบ",
      focus: "การยึดเกาะและความเสียหายของสารเคลือบตลอด Segment",
      evidence: "บันทึกการสำรวจสารเคลือบและภาพถ่ายจุดขุดตรวจ",
      condition: "สารเคลือบหลุดล่อนที่รอยต่อภาคสนาม",
    },
  },
  {
    en: {
      name: "cathodic protection review",
      focus: "rectifier output and test-post potentials",
      evidence: "the rectifier log and the test-post survey sheet",
      condition: "a test-post reading outside the protection criterion in the procedure",
    },
    th: {
      name: "การทบทวนระบบป้องกันการกัดกร่อนแบบแคโทดิก",
      focus: "กระแสจ่ายของ rectifier และค่าศักย์ที่จุดทดสอบ",
      evidence: "บันทึก rectifier และแบบบันทึกการสำรวจจุดทดสอบ",
      condition: "ค่าอ่านที่จุดทดสอบอยู่นอกเกณฑ์การป้องกันตามระเบียบปฏิบัติ",
    },
  },
  {
    en: {
      name: "ILI feature assessment",
      focus: "the indications reported by the in-line inspection tool",
      evidence: "the vendor feature list and the comparison with the previous run",
      condition: "a metal-loss indication awaiting field verification",
    },
    th: {
      name: "การประเมินข้อบ่งชี้จากการตรวจสอบภายในท่อ",
      focus: "ข้อบ่งชี้ที่เครื่องมือตรวจสอบภายในท่อรายงาน",
      evidence: "รายการข้อบ่งชี้จากผู้ให้บริการและการเปรียบเทียบกับรอบตรวจก่อนหน้า",
      condition: "ข้อบ่งชี้การสูญเสียเนื้อโลหะที่รอการยืนยันภาคสนาม",
    },
  },
  {
    en: {
      name: "right-of-way observation",
      focus: "third-party activity and ground condition in the Right-of-Way",
      evidence: "patrol photographs and the excavation-permit register",
      condition: "excavation equipment without a permit parked near the pipeline",
    },
    th: {
      name: "ข้อสังเกตจากการตรวจแนวเขตทาง",
      focus: "กิจกรรมของบุคคลภายนอกและสภาพพื้นดินใน Right-of-Way",
      evidence: "ภาพถ่ายจากการตรวจแนวท่อและทะเบียนใบอนุญาตขุด",
      condition: "เครื่องจักรขุดที่ไม่มีใบอนุญาตจอดอยู่ใกล้แนวท่อ",
    },
  },
  {
    en: {
      name: "marker and signage inspection",
      focus: "pipeline markers and warning signs",
      evidence: "the marker register and patrol photographs",
      condition: "a missing marker post at a road crossing",
    },
    th: {
      name: "การตรวจป้ายและหลักแสดงแนวท่อ",
      focus: "หลักแสดงแนวท่อและป้ายเตือน",
      evidence: "ทะเบียนหลักแสดงแนวท่อและภาพถ่ายจากการตรวจแนวท่อ",
      condition: "หลักแสดงแนวท่อหายไปที่จุดตัดถนน",
    },
  },
  {
    en: {
      name: "valve-station readiness",
      focus: "block-valve station access, condition and function-test records",
      evidence: "the valve function-test record and the site inspection sheet",
      condition: "an overdue valve function test",
    },
    th: {
      name: "ความพร้อมของสถานีวาล์ว",
      focus: "การเข้าถึง สภาพ และบันทึกการทดสอบการทำงานของสถานีวาล์ว",
      evidence: "บันทึกการทดสอบการทำงานของวาล์วและแบบตรวจสถานี",
      condition: "การทดสอบการทำงานของวาล์วที่เลยกำหนด",
    },
  },
  {
    en: {
      name: "repair-work preparation",
      focus: "the work scope, isolation plan and permits for a planned repair",
      evidence: "the draft work pack and the permit register",
      condition: "a work pack that cites a superseded procedure revision",
    },
    th: {
      name: "การเตรียมงานซ่อมบำรุง",
      focus: "ขอบเขตงาน แผนการตัดแยกระบบ และใบอนุญาตสำหรับงานซ่อมที่วางแผนไว้",
      evidence: "ชุดเอกสารงานฉบับร่างและทะเบียนใบอนุญาต",
      condition: "ชุดเอกสารงานที่อ้างอิง revision ของระเบียบปฏิบัติที่ถูกแทนที่แล้ว",
    },
  },
  {
    en: {
      name: "inspection record quality",
      focus: "the completeness and traceability of inspection records",
      evidence: "a sample of inspection sheets and their source files",
      condition: "inspection sheets without a recorded inspector or date",
    },
    th: {
      name: "คุณภาพบันทึกการตรวจสอบ",
      focus: "ความครบถ้วนและการตรวจสอบย้อนกลับได้ของบันทึกการตรวจสอบ",
      evidence: "ตัวอย่างแบบบันทึกการตรวจสอบและไฟล์ต้นทาง",
      condition: "แบบบันทึกการตรวจสอบที่ไม่ระบุผู้ตรวจหรือวันที่",
    },
  },
  {
    en: {
      name: "maintenance handover",
      focus: "open work and outstanding checks passed between maintenance shifts",
      evidence: "the shift handover log and the list of open work orders",
      condition: "an open work order missing from the handover log",
    },
    th: {
      name: "การส่งมอบงานบำรุงรักษา",
      focus: "งานค้างและรายการตรวจที่ส่งต่อระหว่างกะบำรุงรักษา",
      evidence: "บันทึกการส่งมอบกะและรายการใบสั่งงานที่ยังเปิดอยู่",
      condition: "ใบสั่งงานที่ยังเปิดอยู่แต่ไม่ปรากฏในบันทึกการส่งมอบกะ",
    },
  },
  {
    en: {
      name: "evidence traceability",
      focus: "the link between each Evidence item and its source record",
      evidence: "the Evidence register and the source files it references",
      condition: "an Evidence item whose source file cannot be located",
    },
    th: {
      name: "การตรวจสอบย้อนกลับของหลักฐาน",
      focus: "ความเชื่อมโยงระหว่าง Evidence แต่ละรายการกับบันทึกต้นทาง",
      evidence: "ทะเบียน Evidence และไฟล์ต้นทางที่อ้างอิง",
      condition: "Evidence ที่ไม่พบไฟล์ต้นทาง",
    },
  },
  {
    en: {
      name: "management review",
      focus: "open integrity actions and overdue reviews",
      evidence: "the action tracker and the minutes of the previous review",
      condition: "a review action without an assigned owner",
    },
    th: {
      name: "การทบทวนโดยฝ่ายบริหาร",
      focus: "รายการดำเนินการด้านความสมบูรณ์ที่ยังเปิดอยู่และการทบทวนที่เลยกำหนด",
      evidence: "ตารางติดตามการดำเนินการและรายงานการประชุมทบทวนครั้งก่อน",
      condition: "รายการดำเนินการจากการทบทวนที่ไม่มีผู้รับผิดชอบ",
    },
  },
];

// Folders follow the Pipeline Domain Pack structure in PRD KL-2. Section text
// may use {subject}, {focus}, {evidence}, {condition}, {chainage} and
// {organisation}. `addedInRevisionB` is the section that revision B adds.
const DOCUMENT_TYPES = [
  {
    code: "PROC",
    key: "procedure",
    folder: "Company Standards/Procedures",
    title: { en: "Synthetic work procedure", th: "ระเบียบปฏิบัติงานจำลอง" },
    sections: {
      en: [
        ["Purpose", "This procedure sets out how {organisation} carries out the {subject} for DL-01. It covers {focus}."],
        ["Responsibilities", "A qualified reviewer checks {evidence}, the work scope and the required controls before work is planned. A second person records the review outcome."],
        ["Procedure", "1. Confirm the revision of this procedure.\n2. Collect {evidence} for {chainage}.\n3. Compare what the records show with the approved work scope.\n4. Record each finding with its source, for example {condition}.\n5. Stop and escalate if the source, location or authorisation is unclear."],
        ["Records", "Retain the review record, {evidence} and any follow-up request under the document-control process."],
      ],
      th: [
        ["วัตถุประสงค์", "ระเบียบปฏิบัตินี้กำหนดวิธีที่{organisation}ดำเนิน{subject}สำหรับ DL-01 โดยครอบคลุม{focus}"],
        ["หน้าที่รับผิดชอบ", "ผู้ทบทวนที่มีคุณสมบัติตรวจสอบ{evidence} ขอบเขตงาน และมาตรการควบคุมที่จำเป็นก่อนวางแผนงาน บุคคลที่สองบันทึกผลการทบทวน"],
        ["ขั้นตอนปฏิบัติ", "1. ยืนยัน revision ของระเบียบปฏิบัตินี้\n2. รวบรวม{evidence}สำหรับ {chainage}\n3. เปรียบเทียบสิ่งที่บันทึกแสดงกับขอบเขตงานที่อนุมัติ\n4. บันทึกข้อค้นพบแต่ละรายการพร้อมแหล่งที่มา เช่น {condition}\n5. หยุดและยกระดับเมื่อแหล่งข้อมูล ตำแหน่ง หรือการอนุมัติไม่ชัดเจน"],
        ["บันทึก", "เก็บบันทึกการทบทวน {evidence} และคำขอติดตามผลตามกระบวนการควบคุมเอกสาร"],
      ],
    },
    addedInRevisionB: {
      en: ["Escalation", "If {condition} or a similar finding is recorded, the reviewer notifies the Technical Authority before any work is planned."],
      th: ["การยกระดับ", "หากบันทึกพบ{condition}หรือข้อค้นพบลักษณะเดียวกัน ผู้ทบทวนต้องแจ้ง Technical Authority ก่อนวางแผนงาน"],
    },
  },
  {
    code: "ILI",
    key: "ili-report",
    folder: "Integrity/ILI Reports",
    title: { en: "Synthetic ILI report", th: "รายงาน ILI จำลอง" },
    sections: {
      en: [
        ["Scope", "This fictional report covers the {subject} for DL-01 at {chainage}. It is not an engineering assessment."],
        ["Record summary", "The review examined {focus}. The SYNTHETIC record set consists of {evidence}. It describes one fictional condition: {condition}. No real inspection run or pipeline measurement is represented, and no dimensions are given."],
        ["Review notes", "A qualified integrity engineer should verify the source file, tool configuration, sizing basis and any required validation before interpreting an indication."],
        ["Limitations", "This document must not be used to make a fitness-for-service, repair, pressure or return-to-service decision."],
      ],
      th: [
        ["ขอบเขต", "รายงานสมมตินี้ครอบคลุม{subject}ของ DL-01 ที่ {chainage} ไม่ใช่การประเมินทางวิศวกรรม"],
        ["สรุปบันทึก", "การทบทวนพิจารณา{focus} ชุดบันทึก SYNTHETIC ประกอบด้วย{evidence} และบรรยายสภาพสมมติหนึ่งรายการ คือ {condition} ไม่มีการตรวจจริงหรือการวัดท่อจริงรวมอยู่ และไม่ระบุขนาดใด ๆ"],
        ["ข้อสังเกตในการทบทวน", "วิศวกรความสมบูรณ์ที่มีคุณสมบัติควรตรวจสอบไฟล์ต้นทาง การตั้งค่าเครื่องมือ หลักการกำหนดขนาด และการยืนยันผลที่จำเป็นก่อนแปลผลข้อบ่งชี้"],
        ["ข้อจำกัด", "ห้ามใช้เอกสารนี้เพื่อตัดสินความเหมาะสมต่อการใช้งาน การซ่อมแซม แรงดัน หรือการกลับเข้าปฏิบัติงาน"],
      ],
    },
    addedInRevisionB: {
      en: ["Verification plan", "Field verification at {chainage} is proposed for a person to approve. This report does not schedule or authorise it."],
      th: ["แผนการยืนยันผล", "เสนอให้มีการยืนยันผลภาคสนามที่ {chainage} เพื่อให้บุคคลพิจารณาอนุมัติ รายงานนี้ไม่ได้กำหนดเวลาหรืออนุมัติงานดังกล่าว"],
    },
  },
  {
    code: "PATROL",
    key: "patrol-log",
    folder: "Maintenance/Patrol Logs",
    title: { en: "Synthetic patrol log", th: "บันทึกการตรวจแนวท่อจำลอง" },
    sections: {
      en: [
        ["Patrol scope", "A fictional patrol entry by {organisation} for DL-01 at {chainage}. The patrol looked at {focus}. The entry does not identify a real route or Organisation."],
        ["Observation", "SYNTHETIC observation: {condition}. Location: {chainage}. Supporting records: {evidence}."],
        ["Immediate response", "No field response is represented. A qualified person must assess any real observation and use the Organisation's approved response process."],
        ["Follow-up", "Record the source, review decision and any request for further inspection. Keep unverified observations separate from accepted Evidence."],
      ],
      th: [
        ["ขอบเขตการตรวจ", "รายการตรวจแนวท่อสมมติของ{organisation}สำหรับ DL-01 ที่ {chainage} การตรวจครั้งนี้ดู{focus} รายการนี้ไม่ระบุเส้นทางหรือ Organisation จริง"],
        ["ข้อสังเกต", "ข้อสังเกต SYNTHETIC: {condition} ตำแหน่ง: {chainage} บันทึกประกอบ: {evidence}"],
        ["การตอบสนองทันที", "ไม่มีการตอบสนองภาคสนามจริง ผู้มีคุณสมบัติต้องประเมินข้อสังเกตจริงและใช้กระบวนการตอบสนองที่ Organisation อนุมัติ"],
        ["การติดตามผล", "บันทึกแหล่งข้อมูล ผลการทบทวน และคำขอตรวจสอบเพิ่มเติม แยกข้อสังเกตที่ยังไม่ยืนยันออกจาก Evidence ที่ยอมรับแล้ว"],
      ],
    },
    addedInRevisionB: {
      en: ["Reviewer comment", "A second person checked the entry against {evidence} and asked for a repeat patrol of {chainage}."],
      th: ["ความเห็นของผู้ทบทวน", "บุคคลที่สองตรวจรายการนี้เทียบกับ{evidence} และขอให้ตรวจแนวท่อซ้ำที่ {chainage}"],
    },
  },
  {
    code: "RCA",
    key: "root-cause-analysis",
    folder: "Lessons Learned/Root-Cause Analyses",
    title: { en: "Synthetic root-cause analysis", th: "รายงานวิเคราะห์สาเหตุรากจำลอง" },
    sections: {
      en: [
        ["Event summary", "This is a fictional learning scenario about the {subject} for DL-01 at {chainage}. The scenario starts from one finding: {condition}. No incident, injury, release or asset damage occurred."],
        ["Evidence reviewed", "The review used {evidence}, all marked SYNTHETIC. Missing or conflicting records are listed as open questions, not treated as fact."],
        ["Cause analysis", "Candidate contributing factors relate to {focus}. They are hypotheses for human review. The document does not assign fault or establish a final cause."],
        ["Actions for review", "A responsible reviewer may propose follow-up questions or preventive learning. No action is approved or sent to a system of record by this document."],
      ],
      th: [
        ["สรุปเหตุการณ์", "นี่คือสถานการณ์เรียนรู้สมมติเกี่ยวกับ{subject}ของ DL-01 ที่ {chainage} สถานการณ์เริ่มจากข้อค้นพบหนึ่งรายการ คือ {condition} ไม่มีเหตุการณ์ การบาดเจ็บ การรั่วไหล หรือความเสียหายต่อ Asset เกิดขึ้นจริง"],
        ["หลักฐานที่ทบทวน", "การทบทวนใช้{evidence} ซึ่งติดป้าย SYNTHETIC ทั้งหมด บันทึกที่ขาดหรือขัดแย้งจะระบุเป็นคำถามเปิด ไม่ถือเป็นข้อเท็จจริง"],
        ["การวิเคราะห์สาเหตุ", "ปัจจัยที่อาจเกี่ยวข้องสัมพันธ์กับ{focus} เป็นสมมติฐานสำหรับให้บุคคลทบทวน เอกสารนี้ไม่ระบุความผิดหรือยืนยันสาเหตุสุดท้าย"],
        ["การดำเนินการเพื่อทบทวน", "ผู้ทบทวนอาจเสนอคำถามติดตามหรือบทเรียนป้องกันได้ เอกสารนี้ไม่ได้อนุมัติหรือส่งการดำเนินการไปยังระบบบันทึกหลัก"],
      ],
    },
    addedInRevisionB: {
      en: ["Open questions", "Which record first showed {condition}? Was {evidence} complete at the time of the review?"],
      th: ["คำถามเปิด", "บันทึกใดแสดง{condition}เป็นครั้งแรก และ{evidence}ครบถ้วน ณ เวลาที่ทบทวนหรือไม่"],
    },
  },
  {
    code: "MEMO",
    key: "memo",
    folder: "Integrity/Engineering Memos",
    title: { en: "Synthetic engineering memo", th: "บันทึกวิศวกรรมจำลอง" },
    sections: {
      en: [
        ["Purpose", "Summarise the status of the {subject} for DL-01 at {chainage} for {organisation}."],
        ["Context", "The review covers {focus} and relies on {evidence}. One item is open: {condition}. All Asset references and observations are fictional and labelled SYNTHETIC. This memo is not a Technical Authority decision."],
        ["Review requested", "Please verify the source, revision, assumptions and limitations before accepting any statement as Evidence."],
        ["Disposition", "For human review. No approval, repair instruction, operating limit or external submission is created by this memo."],
      ],
      th: [
        ["วัตถุประสงค์", "สรุปสถานะ{subject}ของ DL-01 ที่ {chainage} สำหรับ{organisation}"],
        ["บริบท", "การทบทวนครอบคลุม{focus} และอาศัย{evidence} มีรายการที่ยังเปิดอยู่หนึ่งรายการ คือ {condition} การอ้างถึง Asset และข้อสังเกตทั้งหมดเป็นข้อมูลสมมติและติดป้าย SYNTHETIC บันทึกนี้ไม่ใช่คำวินิจฉัยของ Technical Authority"],
        ["คำขอทบทวน", "โปรดยืนยันแหล่งข้อมูล revision สมมติฐาน และข้อจำกัดก่อนยอมรับข้อความใดเป็น Evidence"],
        ["สถานะ", "เพื่อให้บุคคลทบทวน บันทึกนี้ไม่ได้สร้างการอนุมัติ คำสั่งซ่อม ขีดจำกัดการเดินระบบ หรือการยื่นเอกสารภายนอก"],
      ],
    },
    addedInRevisionB: {
      en: ["Next review", "The open item is carried to the next management review. A person names the owner of that review."],
      th: ["การทบทวนครั้งถัดไป", "รายการที่ยังเปิดอยู่จะนำเข้าการทบทวนโดยฝ่ายบริหารครั้งถัดไป โดยให้บุคคลเป็นผู้กำหนดผู้รับผิดชอบการทบทวน"],
    },
  },
];

const DOCUMENT_TEXT = {
  en: {
    banner: {
      [REVIEW_PENDING]: "Candidate document for demonstration only. Human review is pending.",
      [REVIEW_PASSED]: "Demonstration document. Human review passed.",
    },
    review: { [REVIEW_PENDING]: "pending human review", [REVIEW_PASSED]: "passed human review" },
    changesHeading: "Changes in this revision",
    initialIssue: "Initial issue.",
    addedSection: (heading) => `Supersedes revision A. Adds the section "${heading}".`,
    controlHeading: "Document control",
    revisionLabel: "Revision",
    statusLabel: "Status",
    recordedOnLabel: "Recorded on",
    recordedOnNote: "synthetic record date",
    reviewLabel: "Review",
    disclaimer: "All identifiers, observations and values in this document are fictional. No field activity occurred.",
  },
  th: {
    banner: {
      [REVIEW_PENDING]: "เอกสาร candidate สำหรับการสาธิตเท่านั้น รอการทบทวนโดยบุคคล",
      [REVIEW_PASSED]: "เอกสารสำหรับการสาธิต ผ่านการทบทวนโดยบุคคลแล้ว",
    },
    review: { [REVIEW_PENDING]: "รอการทบทวนโดยบุคคล", [REVIEW_PASSED]: "ผ่านการทบทวนโดยบุคคลแล้ว" },
    changesHeading: "การเปลี่ยนแปลงใน revision นี้",
    initialIssue: "ออกครั้งแรก",
    addedSection: (heading) => `แทนที่ revision A และเพิ่มหัวข้อ “${heading}”`,
    controlHeading: "การควบคุมเอกสาร",
    revisionLabel: "Revision",
    statusLabel: "สถานะ",
    recordedOnLabel: "วันที่บันทึก",
    recordedOnNote: "วันที่บันทึกแบบ SYNTHETIC",
    reviewLabel: "การทบทวน",
    disclaimer: "ตัวระบุ ข้อสังเกต และค่าทั้งหมดในเอกสารนี้เป็นข้อมูลสมมติ ไม่มีกิจกรรมภาคสนามเกิดขึ้นจริง",
  },
};

function reviewedContentHash(content) {
  // Exclude lifecycle annotations; keep authored text and all other metadata.
  const authored = content.split("\n").filter((line) =>
    !/^(status|review_status|supersedes|superseded_by):/.test(line)
    && !line.startsWith("> SYNTHETIC — ")
    && !/^- (Status|Review|สถานะ|การทบทวน):/.test(line)).join("\n");
  return createHash("sha256").update(authored).digest("hex");
}

function escapeYaml(value) {
  return JSON.stringify(value);
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function filenameFor(documentId) {
  return `${documentId.toLowerCase()}.md`;
}

function formatMetres(metres) {
  return String(metres).replace(/\B(?=(\d{3})+$)/g, ",");
}

// A fictional 1,000 m stretch of DL-01, different for every series.
function chainageRange(typeIndex, subjectIndex) {
  const chainageFrom = 4_000 + subjectIndex * 14_000 + typeIndex * 1_500;
  return { chainageFrom, chainageTo: chainageFrom + 1_000 };
}

function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (placeholder, key) => {
    if (!(key in values)) {
      throw new Error(`Synthetic corpus template uses unknown placeholder ${placeholder}.`);
    }
    return values[key];
  });
}

function renderDocument(metadata, type, subject) {
  const { language, revision } = metadata;
  const text = DOCUMENT_TEXT[language];
  const values = {
    subject: subject[language].name,
    focus: subject[language].focus,
    evidence: subject[language].evidence,
    condition: subject[language].condition,
    organisation: ORGANISATION[language],
    chainage: `Chainage ${formatMetres(metadata.chainageFrom)}–${formatMetres(metadata.chainageTo)} m (${SYNTHETIC_LABEL})`,
  };
  const addedSection = type.addedInRevisionB[language];
  const sections = [
    ...type.sections[language],
    ...(revision === "B" ? [addedSection] : []),
    [text.changesHeading, revision === "B" ? text.addedSection(addedSection[0]) : text.initialIssue],
  ]
    .map(([heading, content]) => `## ${heading}\n\n${fillTemplate(content, values)}`)
    .join("\n\n");
  const metadataLines = [
    ["document_id", metadata.documentId],
    ["title", metadata.title],
    ["document_type", metadata.documentType],
    ["language", language],
    ["revision", revision],
    ["status", metadata.status],
    ["review_status", metadata.reviewStatus],
    ["folder", metadata.folder],
    ["classification", metadata.classification],
    ["licence", metadata.licence],
    ["simulated", metadata.simulated],
    ["label", metadata.label],
    ["asset_code", metadata.assetCode],
    ["chainage_from", metadata.chainageFrom],
    ["chainage_to", metadata.chainageTo],
    ["recorded_on", SYNTHETIC_RECORD_DATE],
    ["supersedes", metadata.supersedes],
    ["superseded_by", metadata.supersededBy],
  ]
    .map(([key, value]) => `${key}: ${typeof value === "string" ? escapeYaml(value) : value}`)
    .join("\n");
  const control = [
    `${text.revisionLabel}: ${revision}`,
    `${text.statusLabel}: ${metadata.status}`,
    `${text.recordedOnLabel}: ${SYNTHETIC_RECORD_DATE} (${text.recordedOnNote})`,
    `${text.reviewLabel}: ${text.review[metadata.reviewStatus]}`,
    text.disclaimer,
  ]
    .map((line) => `- ${line}`)
    .join("\n");

  return `---\n${metadataLines}\n---\n\n# ${metadata.title}\n\n> ${SYNTHETIC_LABEL} — ${text.banner[metadata.reviewStatus]}\n\n${sections}\n\n## ${text.controlHeading}\n\n${control}\n`;
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
  if (!LANGUAGES.includes(metadata.language)) {
    throw new Error(`Unsupported corpus language: ${metadata.language}.`);
  }
  if (metadata.reviewStatus === REVIEW_PENDING) {
    if (metadata.status !== "draft") {
      throw new Error("Unreviewed synthetic corpus documents must have draft status.");
    }
  } else if (metadata.reviewStatus === REVIEW_PASSED) {
    if (metadata.status !== "current" && metadata.status !== "superseded") {
      throw new Error("Reviewed synthetic corpus documents must be current or superseded.");
    }
  } else {
    throw new Error(`Unsupported review status: ${metadata.reviewStatus}.`);
  }
  if (typeof content !== "string" || !content.includes(SYNTHETIC_LABEL)) {
    throw new Error("Synthetic corpus document content must include the SYNTHETIC label.");
  }
  if (/\[[^\]]*\]/.test(content.split("\n---\n")[1] ?? content)) {
    throw new Error(`Synthetic corpus document ${metadata.documentId} contains an unfilled placeholder.`);
  }
  return document;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  // Spreadsheet exports may start with a byte-order mark.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && source[index + 1] === "\n") {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell !== ""));
}

/**
 * Reads the decisions people recorded in a review checklist, keyed by
 * document ID. Rows without a reviewer, decision, date or note are skipped.
 */
export function parseReviewChecklist(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) {
    return new Map();
  }
  const column = (name) => {
    const index = header.indexOf(name);
    if (index === -1) {
      throw new Error(`Review checklist is missing the ${name} column.`);
    }
    return index;
  };
  const columns = {
    documentId: column("document_id"),
    reviewHash: header.indexOf("review_hash"),
    reviewer: column("reviewer"),
    decision: column("decision"),
    reviewedAt: column("reviewed_at"),
    notes: column("notes"),
  };
  const reviews = new Map();
  for (const row of rows) {
    const documentId = (row[columns.documentId] ?? "").trim();
    const review = {
      reviewHash: (row[columns.reviewHash] ?? "").trim(),
      reviewer: (row[columns.reviewer] ?? "").trim(),
      decision: (row[columns.decision] ?? "").trim().toLowerCase(),
      reviewedAt: (row[columns.reviewedAt] ?? "").trim(),
      notes: row[columns.notes] ?? "",
    };
    if (!documentId) {
      throw new Error("Review checklist contains a row without a document_id.");
    }
    if (reviews.has(documentId)) {
      throw new Error(`Review checklist repeats ${documentId}.`);
    }
    if (review.decision !== "" && review.decision !== DECISION_PASS && review.decision !== DECISION_FAIL) {
      throw new Error(`Review decision for ${documentId} must be "pass", "fail" or blank.`);
    }
    if (review.decision !== "" && (review.reviewer === "" || review.reviewedAt === "")) {
      throw new Error(`Review decision for ${documentId} requires a reviewer and reviewed_at.`);
    }
    if (review.reviewer || review.decision || review.reviewedAt || review.notes) {
      reviews.set(documentId, review);
    }
  }
  return reviews;
}

/**
 * Builds the corpus. `reviews` holds the decisions people recorded in the
 * checklist: a failed document is left out of the documents and the manifest,
 * and a passed one becomes current, or superseded once its successor passes.
 */
export function buildCorpus(reviews = new Map()) {
  const candidates = [];
  DOCUMENT_TYPES.forEach((type, typeIndex) => {
    for (const language of LANGUAGES) {
      SUBJECTS.forEach((subject, subjectIndex) => {
        const seriesId = `SYN-UC1-${type.code}-${language.toUpperCase()}-${String(subjectIndex + 1).padStart(3, "0")}`;
        for (const revision of REVISIONS) {
          candidates.push({ seriesId, documentId: `${seriesId}-${revision}`, revision, type, typeIndex, language, subject, subjectIndex });
        }
      });
    }
  });

  const candidateIds = new Set(candidates.map(({ documentId }) => documentId));
  if (candidateIds.size !== candidates.length) {
    throw new Error("Synthetic corpus generator produced duplicate document IDs.");
  }
  if (candidates.length < 200 || candidates.length > 300) {
    throw new Error(`Synthetic corpus must contain 200–300 documents; got ${candidates.length}.`);
  }
  for (const documentId of reviews.keys()) {
    if (!candidateIds.has(documentId)) {
      throw new Error(`Review checklist names unknown document ${documentId}.`);
    }
  }

  const decisionFor = (documentId) => reviews.get(documentId)?.decision ?? "";
  const reviewHashes = new Map();
  const documents = [];
  for (const candidate of candidates) {
    const { seriesId, documentId, revision, type, language, subject } = candidate;
    const predecessorId = revision === "B" ? `${seriesId}-A` : null;
    const successorId = revision === "A" ? `${seriesId}-B` : null;
    const passed = decisionFor(documentId) === DECISION_PASS;
    const metadata = {
      documentId,
      title: `${type.title[language]}: ${subject[language].name}`,
      documentType: type.key,
      language,
      revision,
      status: !passed ? "draft" : successorId && decisionFor(successorId) === DECISION_PASS ? "superseded" : "current",
      reviewStatus: passed ? REVIEW_PASSED : REVIEW_PENDING,
      folder: type.folder,
      classification: "INTERNAL",
      licence: "synthetic",
      simulated: true,
      label: SYNTHETIC_LABEL,
      assetCode: ASSET_CODE,
      ...chainageRange(candidate.typeIndex, candidate.subjectIndex),
      supersedes: predecessorId && decisionFor(predecessorId) !== DECISION_FAIL ? predecessorId : null,
      supersededBy: successorId && decisionFor(successorId) !== DECISION_FAIL ? successorId : null,
    };
    // Review binds to the authored text and immutable metadata. Lifecycle
    // annotations change after review without changing the reviewed material.
    const reviewHash = reviewedContentHash(renderDocument(metadata, type, subject));
    reviewHashes.set(documentId, reviewHash);
    const review = reviews.get(documentId);
    if (review?.decision && review.reviewHash !== reviewHash) {
      throw new Error(`The reviewed content of ${documentId} changed or has no bound hash. Archive the old checklist, clear its decision, regenerate and review the new content.`);
    }
    if (decisionFor(documentId) === DECISION_FAIL) {
      continue;
    }
    metadata.reviewHash = reviewHash;
    const document = {
      metadata,
      filename: filenameFor(documentId),
      content: renderDocument(metadata, type, subject),
    };
    validateDocument(document);
    documents.push(document);
  }

  const countReviewStatus = (reviewStatus) =>
    documents.filter(({ metadata }) => metadata.reviewStatus === reviewStatus).length;
  const manifest = {
    schemaVersion: 3,
    generatedBy: "data/synthetic/corpus/generate.mjs",
    recordedOn: SYNTHETIC_RECORD_DATE,
    label: SYNTHETIC_LABEL,
    review: {
      pending: countReviewStatus(REVIEW_PENDING),
      passed: countReviewStatus(REVIEW_PASSED),
      failedAndRemoved: candidates.length - documents.length,
    },
    documentCount: documents.length,
    documents: documents.map(({ metadata, filename }) => ({
      ...metadata,
      contentPath: `documents/${filename}`,
    })),
  };

  // The checklist keeps a row for every candidate, so a failed document's
  // decision stays on record after its file is removed.
  const checklist = [
    CHECKLIST_HEADER,
    ...candidates.map(({ documentId, revision, type, language, subject }) => {
      const review = reviews.get(documentId);
      return [
        documentId,
        `${type.title[language]}: ${subject[language].name}`,
        language,
        type.key,
        revision,
        type.folder,
        reviewHashes.get(documentId),
        review?.reviewer ?? "",
        review?.decision ?? "",
        review?.reviewedAt ?? "",
        review?.notes ?? "",
      ];
    }),
  ]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\n");

  return { documents, manifest, reviewHashes, checklist: `${checklist}\n` };
}

async function readRecordedReviews(checklistPath) {
  try {
    return parseReviewChecklist(await readFile(checklistPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

export async function writeCorpus(outputDir = DEFAULT_OUTPUT_DIR) {
  const outputPath = resolve(outputDir);
  const documentsPath = resolve(outputPath, "documents");
  const checklistPath = resolve(outputPath, "review-checklist.csv");
  // Decisions already recorded in the checklist survive a rerun.
  const reviews = await readRecordedReviews(checklistPath);
  const { documents, manifest, reviewHashes, checklist } = buildCorpus(reviews);
  // A reviewer may have edited a candidate file. Never replace those edits and
  // claim the generated replacement passed the review of the edited file.
  for (const [documentId, review] of reviews) {
    if (!review.decision) continue;
    try {
      const existing = await readFile(resolve(documentsPath, filenameFor(documentId)), "utf8");
      if (reviewedContentHash(existing) !== reviewHashes.get(documentId)) {
        throw new Error(`The reviewed content of ${documentId} differs from the generated content. Archive the checklist and review a regenerated candidate.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT" || review.decision !== DECISION_FAIL) throw error;
    }
  }
  await mkdir(documentsPath, { recursive: true });
  const retained = new Set(documents.map(({ filename }) => filename));
  const stale = (await readdir(documentsPath)).filter(
    (filename) => filename.endsWith(".md") && !retained.has(filename),
  );
  await Promise.all([
    ...stale.map((filename) => rm(resolve(documentsPath, filename))),
    ...documents.map(({ filename, content }) =>
      writeFile(resolve(documentsPath, filename), content, "utf8"),
    ),
  ]);
  await Promise.all([
    writeFile(resolve(outputPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(checklistPath, checklist, "utf8"),
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
  process.stdout.write(`Wrote ${manifest.documentCount} synthetic documents to ${outputDir} (${manifest.review.pending} pending human review, ${manifest.review.passed} passed, ${manifest.review.failedAndRemoved} failed and removed).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
