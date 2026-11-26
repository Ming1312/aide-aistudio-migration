// 三個角色（訪客／員工／管理員）的權限表：前端與伺服器共用（沒有任何 Node 或瀏覽器專屬的東西）。
// 內部多一個 demo_admin（公開展示帳號 demo／aide-demo）：能做員工與管理員的畫面操作，但伺服器永遠不替它寫入引擎。
export type Role = "viewer" | "staff" | "demo_admin" | "admin";

export type Permission =
  | "record_decision" // 記錄決策
  | "import_data" // 資料匯入（含伺服器代取檔案）
  | "view_engine" // 看引擎連線狀態
  | "edit_thresholds" // 改風險門檻
  | "view_admin_status" // 管理狀態面板
  | "engine_write"; // 引擎寫入（只有正式管理者；伺服器端強制）

const TABLE: Record<Permission, ReadonlyArray<Role>> = {
  record_decision: ["staff", "demo_admin", "admin"],
  import_data: ["staff", "demo_admin", "admin"],
  view_engine: ["staff", "demo_admin", "admin"],
  edit_thresholds: ["demo_admin", "admin"],
  view_admin_status: ["demo_admin", "admin"],
  engine_write: ["admin"],
};

export function can(role: Role, permission: Permission): boolean {
  return TABLE[permission].includes(role);
}

/** 顯示用的三個角色名稱（demo_admin 顯示成「管理員（展示）」） */
export const ROLE_NAME: Record<Role, string> = {
  viewer: "訪客",
  staff: "員工",
  demo_admin: "管理員（展示）",
  admin: "管理員",
};

export const PERMISSION_LABEL: Record<Permission, string> = {
  record_decision: "記錄決策",
  import_data: "資料匯入",
  view_engine: "引擎連線狀態",
  edit_thresholds: "改風險門檻",
  view_admin_status: "管理狀態",
  engine_write: "引擎寫入",
};

export const PERMISSION_ORDER: Permission[] = [
  "record_decision",
  "import_data",
  "view_engine",
  "edit_thresholds",
  "view_admin_status",
  "engine_write",
];
