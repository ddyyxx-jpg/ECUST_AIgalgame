/**
 * 室内二级地图定义。
 *
 * 每个室内是一套独立的像素坐标系（1600×1200），与校园大地图（6000×4500）无关；
 * 进入室内只切换渲染，不改变世界状态里的 locId —— 玩家仍然"在那个地点"。
 */

export interface InteriorSpot {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 点位类型：决定标记样式 */
  kind: "service" | "area" | "facility";
}

export interface InteriorMap {
  /** public 下的底图 */
  image: string;
  width: number;
  height: number;
  /** 刚进门时站的位置 */
  spawn: { x: number; y: number };
  /** 出口（走到附近点它就能回到大地图） */
  exit: { x: number; y: number };
  spots: InteriorSpot[];
}

const W = 1600;
const H = 1200;
/** 出生点离出口留出距离，否则一进门就满足"靠近出口"的条件 */
const SPAWN = { x: 800, y: 940 };
const EXIT = { x: 800, y: 1150 };

function mk(image: string, spots: InteriorSpot[]): InteriorMap {
  return { image, width: W, height: H, spawn: { ...SPAWN }, exit: { ...EXIT }, spots };
}

export const LIBRARY_INTERIOR = mk("/map/library-interior.png", [
  { id: "lib_counter", name: "借阅台", x: 800, y: 470, kind: "service" },
  { id: "lib_reading", name: "自习区", x: 800, y: 230, kind: "area" },
  { id: "lib_shelf_w", name: "西书架区", x: 270, y: 500, kind: "area" },
  { id: "lib_shelf_e", name: "东书架区", x: 1330, y: 500, kind: "area" },
  { id: "lib_digital", name: "电子阅览室", x: 1315, y: 970, kind: "facility" },
  { id: "lib_stairs", name: "楼梯", x: 210, y: 980, kind: "facility" },
]);

export const CLASSROOM_INTERIOR = mk("/map/in-classroom.png", [
  { id: "cls_1", name: "教室 1", x: 265, y: 185, kind: "area" },
  { id: "cls_2", name: "教室 2", x: 615, y: 185, kind: "area" },
  { id: "cls_3", name: "教室 3", x: 965, y: 185, kind: "area" },
  { id: "cls_4", name: "教室 4", x: 1315, y: 185, kind: "area" },
  { id: "cls_6", name: "教室 6", x: 615, y: 365, kind: "area" },
  { id: "cls_9", name: "教室 9", x: 265, y: 545, kind: "area" },
  { id: "cls_11", name: "教室 11", x: 965, y: 545, kind: "area" },
  { id: "cls_13", name: "教室 13", x: 265, y: 905, kind: "area" },
  { id: "cls_14", name: "教室 14", x: 615, y: 905, kind: "area" },
  { id: "cls_15", name: "教室 15", x: 965, y: 905, kind: "area" },
  { id: "cls_16", name: "教室 16", x: 1315, y: 905, kind: "area" },
  { id: "cls_hall", name: "走廊", x: 800, y: 1050, kind: "area" },
]);

export const CANTEEN_INTERIOR = mk("/map/in-canteen.png", [
  { id: "can_window", name: "打饭窗口", x: 800, y: 190, kind: "service" },
  { id: "can_hall", name: "就餐区", x: 800, y: 700, kind: "area" },
  { id: "can_water", name: "餐具回收处", x: 1350, y: 200, kind: "facility" },
]);

export const GYM_INTERIOR = mk("/map/in-gym.png", [
  { id: "gym_court", name: "球场", x: 800, y: 600, kind: "area" },
  { id: "gym_bench", name: "看台", x: 200, y: 600, kind: "area" },
  { id: "gym_equip", name: "器材室", x: 1400, y: 300, kind: "facility" },
]);

export const STADIUM_INTERIOR = mk("/map/in-stadium.png", [
  { id: "std_track", name: "跑道", x: 800, y: 300, kind: "area" },
  { id: "std_field", name: "草坪", x: 800, y: 620, kind: "area" },
  { id: "std_stand", name: "看台", x: 200, y: 600, kind: "area" },
]);

export const DORM_INTERIOR = mk("/map/in-dorm.png", [
  { id: "dorm_101", name: "101 寝室", x: 380, y: 565, kind: "area" },
  { id: "dorm_201", name: "201 寝室", x: 1220, y: 565, kind: "area" },
  { id: "dorm_503", name: "503 寝室", x: 380, y: 885, kind: "area" },
  { id: "dorm_603", name: "603 寝室", x: 1220, y: 885, kind: "area" },
  { id: "dorm_704", name: "704 寝室", x: 380, y: 1045, kind: "area" },
  { id: "dorm_804", name: "804 寝室", x: 1220, y: 1045, kind: "area" },
  { id: "dorm_corridor", name: "走道", x: 800, y: 435, kind: "area" },
  { id: "dorm_bath", name: "盥洗 / 洗衣", x: 1220, y: 235, kind: "facility" },
  { id: "dorm_activity", name: "公共活动室", x: 460, y: 235, kind: "area" },
]);

export const LAB_INTERIOR = mk("/map/in-lab.png", [
  { id: "lab_hall", name: "实验区", x: 800, y: 600, kind: "area" },
  { id: "lab_1", name: "实验台 1", x: 340, y: 210, kind: "facility" },
  { id: "lab_2", name: "实验台 2", x: 780, y: 210, kind: "facility" },
  { id: "lab_3", name: "实验台 3", x: 1220, y: 210, kind: "facility" },
]);

export const INFO_INTERIOR = mk("/map/in-info.png", [
  { id: "info_serv", name: "服务台", x: 800, y: 340, kind: "service" },
  { id: "info_hall", name: "大厅", x: 800, y: 610, kind: "area" },
  { id: "info_room", name: "机房", x: 305, y: 400, kind: "facility" },
  { id: "info_read", name: "自习区", x: 1290, y: 370, kind: "area" },
  { id: "info_report", name: "报告厅", x: 1290, y: 900, kind: "area" },
]);

export const ACTIVITY_INTERIOR = mk("/map/in-activity.png", [
  { id: "act_a", name: "A 区", x: 520, y: 400, kind: "area" },
  { id: "act_b", name: "B 区", x: 800, y: 400, kind: "area" },
  { id: "act_c", name: "C 区", x: 1080, y: 400, kind: "area" },
]);

/** 室内 NPC 的落位（按索引轮换，保证同馆内几个人不重叠） */
const NPC_SPOTS: Array<{ x: number; y: number }> = [
  { x: 660, y: 250 },
  { x: 940, y: 250 },
  { x: 600, y: 640 },
  { x: 1000, y: 640 },
  { x: 300, y: 330 },
  { x: 1300, y: 330 },
];

export function interiorNpcSpot(index: number): { x: number; y: number } {
  return NPC_SPOTS[index % NPC_SPOTS.length]!;
}

/** 哪些场景有室内地图（场景 id → 室内地图） */
export const INTERIORS: Record<string, InteriorMap> = {
  // 图书馆
  loc_library: LIBRARY_INTERIOR,
  // 教学楼（A/B/C/D + E）
  loc_teaching_a: CLASSROOM_INTERIOR,
  loc_teaching_b: CLASSROOM_INTERIOR,
  loc_teaching_c: CLASSROOM_INTERIOR,
  loc_teaching_d: CLASSROOM_INTERIOR,
  loc_teaching_1: CLASSROOM_INTERIOR,
  // 食堂
  loc_canteen: CANTEEN_INTERIOR,
  loc_canteen2: CANTEEN_INTERIOR,
  // 体育
  loc_playground: STADIUM_INTERIOR,
  loc_gym: GYM_INTERIOR,
  loc_courts: GYM_INTERIOR,
  // 生活
  loc_dorm3: DORM_INTERIOR,
  loc_activity: ACTIVITY_INTERIOR,
  loc_info_hall: INFO_INTERIOR,
  // 实验
  loc_lab_25: LAB_INTERIOR,
  loc_lab_67: LAB_INTERIOR,
  loc_gongxun: LAB_INTERIOR,
};

export function interiorFor(sceneId: string | undefined | null): InteriorMap | null {
  if (!sceneId) return null;
  return INTERIORS[sceneId] ?? null;
}
