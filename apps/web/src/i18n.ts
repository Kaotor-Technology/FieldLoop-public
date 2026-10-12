import i18next from "i18next";
import { initReactI18next } from "react-i18next";

void i18next.use(initReactI18next).init({
  lng: "en", fallbackLng: "en", initAsync: false,
  interpolation: { escapeValue: false },
  resources: {
    en: { translation: {
      loading: "Checking your session", redirecting: "Opening Kaotor SSO",
      unavailable: "Sign-in is temporarily unavailable", retry: "Try again",
      unavailableDetail: "Your session could not be checked. Try again when the connection is available.",
      map: "Geo Command Map", mapPending: "Map layers are being prepared.",
      mapDetail: "Your session is ready. Asset and Barrier layers will appear here when they are available.",
      workspace: "SYNTHETIC / SIMULATION · Demo workspace",
      identity: "Signed-in identity", subject: "Subject", roles: "Roles", persona: "Persona", authTime: "Signed in at",
      switchAccount: "Change demo account", switchDetail: "Sign out of Kaotor SSO, then sign in with the demo account for the role you need.",
      viewer: "Viewer", viewerDetail: "Executive · District Officer",
      operator: "Operator", operatorDetail: "Integrity Engineer · Control-room Operator",
      manager: "Manager", managerDetail: "Technical Authority · Incident Commander · AI Governance Lead",
      confirmSwitch: "Sign out and change account", signingOut: "Signing out", cancel: "Cancel",
      logoutFailed: "Sign-out could not be completed. Try again.", nightShift: "Night shift", skip: "Skip to main content",
    } },
    th: { translation: {
      loading: "กำลังตรวจสอบเซสชัน", redirecting: "กำลังเปิด Kaotor SSO",
      unavailable: "ไม่สามารถเข้าสู่ระบบได้ชั่วคราว", retry: "ลองอีกครั้ง",
      unavailableDetail: "ตรวจสอบเซสชันไม่ได้ โปรดลองอีกครั้งเมื่อเชื่อมต่อได้",
      map: "แผนที่บัญชาการเชิงพื้นที่", mapPending: "กำลังเตรียมชั้นข้อมูลแผนที่",
      mapDetail: "เซสชันพร้อมใช้งาน ชั้นข้อมูลสินทรัพย์และ Barrier จะแสดงที่นี่เมื่อพร้อม",
      workspace: "SYNTHETIC / SIMULATION · พื้นที่สาธิต",
      identity: "ข้อมูลผู้เข้าสู่ระบบ", subject: "รหัสผู้ใช้", roles: "สิทธิ์", persona: "บทบาทในการสาธิต", authTime: "เข้าสู่ระบบเมื่อ",
      switchAccount: "เปลี่ยนบัญชีสาธิต", switchDetail: "ออกจาก Kaotor SSO แล้วเข้าสู่ระบบด้วยบัญชีสาธิตที่มีสิทธิ์ตรงกับบทบาทที่ต้องการ",
      viewer: "ผู้ดูข้อมูล", viewerDetail: "ผู้บริหาร · เจ้าหน้าที่เขต",
      operator: "ผู้ปฏิบัติงาน", operatorDetail: "วิศวกรความสมบูรณ์ของสินทรัพย์ · เจ้าหน้าที่ห้องควบคุม",
      manager: "ผู้มีอำนาจอนุมัติ", managerDetail: "ผู้มีอำนาจทางเทคนิค · ผู้บัญชาการเหตุการณ์ · ผู้นำกำกับดูแล AI",
      confirmSwitch: "ออกจากระบบและเปลี่ยนบัญชี", signingOut: "กำลังออกจากระบบ", cancel: "ยกเลิก",
      logoutFailed: "ออกจากระบบไม่สำเร็จ โปรดลองอีกครั้ง", nightShift: "โหมดกะกลางคืน", skip: "ข้ามไปเนื้อหาหลัก",
    } },
  },
});

export default i18next;
