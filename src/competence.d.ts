/**
 * competence.d.ts — 能力判定核心 src/competence.js 的型別宣告
 *
 * 只給 TypeScript 宿主（特護 tehu-platform）使用，執行期沒有任何地方載入本檔。
 * 與 competence.js 一起原樣複製到 tehu-platform/app/src/lib/kernel/，以 default import 使用：
 *   import kernel from './competence.js';
 * 形狀為 namespace + const + `export =`，對應 competence.js 檔尾的 CommonJS 防護段。
 * tests/competence.test.js 的契約測試會比對本檔與執行期的匯出名稱、版本字串、結果形狀——
 * 只改一邊，測試就紅。
 *
 * 版本只做加法：1.1.0 預留正式的分級能力（grade），CompetenceDef 將新增
 * { label; skill; atLeast; scale } 一型；既有型別與函式簽章不變。在那之前，分級用 rankStatus。
 */
declare namespace kernel {
  /** 'YYYY-MM-DD'，且須為真實存在的日曆日 */
  type ISODate = string;
  /** ISO 效期，或 true＝持有、無效期（特護的技術標籤與無效期證書；班守 D1 只收 ISO） */
  type CertValue = ISODate | true;
  /** 資格（看效期）或臨床進階下限（看 Catalog.ladder） */
  type CompetenceDef =
    | { label: string; cert: string }
    | { label: string; ladderAtLeast: string };
  /** compileProfile 編譯後的設定檔本身就是合格的 Catalog；ladder 由低到高 */
  interface Catalog { competences: Record<string, CompetenceDef>; ladder: readonly string[] }
  interface Person { id: string; certs?: Record<string, CertValue>; ladder?: string | null }
  /** careDemand 的一格或特護的一案：allMust 每位都須具備；atLeast 至少 min 位（預設 1）具備 */
  interface Needs { allMust?: readonly string[]; atLeast?: ReadonlyArray<{ competence: string; min?: number }> }
  /** 只有 valid 與 expiring 計入（Badge.counts） */
  type BadgeStatus = 'valid' | 'expiring' | 'expired' | 'missing' | 'invalid' | 'below' | 'unrated';
  type RankStatus = 'unrated' | 'invalid' | 'below' | 'meets';
  /** expiringDays：到期提醒視窗（天）；不給則不區分 expiring */
  interface BadgeOptions { expiringDays?: number }
  interface Badge {
    code: string;
    label: string;
    /** unknown＝設定檔沒有此能力代碼，或查無此人 */
    kind: 'cert' | 'ladder' | 'unknown';
    status: BadgeStatus;
    counts: boolean;
    /** ISO 效期；invalid 時為原始登錄值；未持有、true 與臨床進階為 null */
    expiry: string | null;
    /** 效期距基準日天數（過期為負）；沒有 ISO 效期時為 null */
    daysLeft: number | null;
    /** 持有且無效期（CertValue 為 true） */
    noExpiry: boolean;
    /** 給主管看的中文說明；valid 為空字串 */
    text: string;
  }
  /** fills／still：補人前就不足的 atLeast 代碼，依此人能否補足分開；lacks：此人不計入的 allMust */
  interface CandidateDelta { staffId: string; fills: string[]; still: string[]; lacks: Badge[]; restores: boolean }
  /** bench：可完整補回者（restores）的 id，依輸入順序；rows 與輸入一一對應 */
  interface Bench { depth: number; bench: string[]; rows: CandidateDelta[] }
  /** 0 broken（不斷班警訊）／1 thin／2 以上 ok */
  type BenchLevel = 'broken' | 'thin' | 'ok';
}

declare const kernel: {
  readonly COMPETENCE_KERNEL_VERSION: '1.0.0';
  isIsoDate(s: unknown): boolean;
  rankStatus(value: string | null | undefined, scale: readonly string[], atLeast?: string | null): kernel.RankStatus;
  /** onDate 不是 ISO 日期時拋 TypeError */
  badgeOf(catalog: kernel.Catalog, person: kernel.Person | null | undefined, code: string, onDate: kernel.ISODate, opts?: kernel.BadgeOptions): kernel.Badge;
  candidateDelta(catalog: kernel.Catalog, needs: kernel.Needs, onShift: readonly kernel.Person[], candidate: kernel.Person, onDate: kernel.ISODate, opts?: kernel.BadgeOptions): kernel.CandidateDelta;
  /** 只篩不排：合法性由宿主先篩好再傳入 people */
  benchFor(catalog: kernel.Catalog, needs: kernel.Needs, onShift: readonly kernel.Person[], people: readonly kernel.Person[], onDate: kernel.ISODate, opts?: kernel.BadgeOptions): kernel.Bench;
  benchLevel(depth: number): kernel.BenchLevel;
};

export = kernel;
