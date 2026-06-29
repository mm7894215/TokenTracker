import React, { useMemo, useState } from "react";
import { Laptop, Monitor, MonitorSmartphone, Pencil, Check, X } from "lucide-react";
import { Card } from "../../components";
import { copy } from "../../../lib/copy";
import { formatCompactNumber } from "../../../lib/format";
import { formatDeviceLabel } from "../../../lib/device-label";

const DOT_DIVIDER = " · ";
const PCT_SIGN = "%";

// Platform → icon. device.platform comes from tokentracker_devices (e.g.
// "darwin", "win32"/"windows", "linux", "web"); fall back to a generic monitor.
function PlatformIcon({ platform, className }) {
  const p = String(platform || "").toLowerCase();
  if (p.includes("darwin") || p.includes("mac")) return <Laptop className={className} aria-hidden />;
  if (p.includes("win")) return <Monitor className={className} aria-hidden />;
  if (p.includes("linux")) return <Monitor className={className} aria-hidden />;
  return <MonitorSmartphone className={className} aria-hidden />;
}

export function DeviceUsageCard({ devices = [], selectedDeviceId = "", onSelectDevice, onRenameDevice }) {
  const [editingId, setEditingId] = useState("");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [errorId, setErrorId] = useState("");

  const canRename = typeof onRenameDevice === "function";
  const canSelect = typeof onSelectDevice === "function";
  const anySelected = Boolean(selectedDeviceId);

  // Rank heaviest-first so the dominant device leads the breakdown.
  const total = devices.reduce((sum, d) => sum + (Number(d.total_tokens) || 0), 0);
  const ranked = useMemo(
    () => [...devices].sort((a, b) => (Number(b.total_tokens) || 0) - (Number(a.total_tokens) || 0)),
    [devices],
  );

  function beginEdit(d) {
    setErrorId("");
    setEditingId(d.id);
    // Prefill the custom name so it can be tweaked; an auto-named device starts
    // blank so the placeholder invites a fresh, memorable name.
    const raw = typeof d.device_name === "string" ? d.device_name : "";
    setDraft(formatDeviceLabel(d) === raw ? raw : "");
  }

  function cancelEdit() {
    setEditingId("");
    setDraft("");
    setErrorId("");
  }

  async function commitEdit(d) {
    const name = draft.trim();
    if (!name || saving) return;
    setSaving(true);
    setErrorId("");
    try {
      await onRenameDevice(d.id, name);
      setEditingId("");
      setDraft("");
    } catch {
      setErrorId(d.id);
    } finally {
      setSaving(false);
    }
  }

  // 1. 空状态优雅渲染
  if (devices.length === 0) {
    return (
      <Card bodyClassName="!px-3 !py-3.5">
        <div className="flex items-center justify-between gap-2 mb-2 px-2">
          {/* 类名与其他卡片的标题完全一致，且加 px-2 实现左对齐 */}
          <div className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide px-2">
            {copy("dashboard.device_card.title")}
          </div>
        </div>
        <div className="flex flex-col items-center justify-center py-6 text-center">
          <MonitorSmartphone className="h-7 w-7 text-oai-gray-300 dark:text-oai-gray-600 mb-2 stroke-[1.5]" />
          <p className="text-[11px] text-oai-gray-500 dark:text-oai-gray-400 font-medium">
            {copy("dashboard.device_card.empty")}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card bodyClassName="!px-3 !py-3.5">
      {/* 标题栏类名与其他卡片标题完全一致，加 px-2 实现左对齐 */}
      <div className="flex items-center justify-between gap-2 mb-2 px-2">
        <div className="text-sm font-medium text-oai-gray-500 dark:text-oai-gray-300 uppercase tracking-wide">
          {copy("dashboard.device_card.title")}
        </div>
        {canSelect && anySelected && (
          <button
            type="button"
            onClick={() => onSelectDevice("")}
            className="text-xs text-oai-gray-400 hover:text-oai-brand focus:outline-none transition-colors"
          >
            {copy("dashboard.device_card.clear")}
          </button>
        )}
      </div>

      {/* 设备项纵向间距调紧为 space-y-[2px]，提升极致精致感 */}
      <div className="space-y-[2px]">
        {ranked.map((d) => {
          const tokens = Number(d.total_tokens) || 0;
          const percent = total > 0 ? ((tokens / total) * 100).toFixed(1) : "0.0";
          const isSelected = selectedDeviceId === d.id;
          const name = formatDeviceLabel(d) || copy("dashboard.device_card.unnamed");
          const isEditing = editingId === d.id;

          const fillClass = isSelected
            ? "bg-oai-brand"
            : anySelected
              ? "bg-oai-gray-300 dark:bg-oai-gray-600"
              : "bg-oai-brand/50";

          // UX 深度思考：未选中项整体降低透明度（失焦虚化），选中项 100% 实体高亮
          const itemOpacity = anySelected && !isSelected
            ? "opacity-40 hover:opacity-80"
            : "opacity-100";

          return (
            <div key={d.id} className="group relative">
              {isEditing ? (
                /* 2. 编辑状态（对齐 padding，防抖动极紧凑布局） */
                <div className="w-full rounded-md px-2 py-1.5 bg-oai-gray-50/50 dark:bg-oai-gray-900/40">
                  {/* 第一行：左侧输入框，右侧操作按钮 */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <PlatformIcon platform={d.platform} className="h-3.5 w-3.5 shrink-0 text-oai-gray-500 dark:text-oai-gray-400" />
                      <input
                        autoFocus
                        value={draft}
                        disabled={saving}
                        maxLength={60}
                        placeholder={copy("dashboard.device_card.rename_placeholder")}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit(d);
                          else if (e.key === "Escape") cancelEdit();
                        }}
                        className="flex-1 min-w-0 bg-transparent text-xs font-medium text-oai-black dark:text-oai-white border-b border-oai-gray-300 dark:border-oai-gray-700 focus:outline-none focus:border-oai-brand py-0"
                      />
                    </div>
                    <div className="shrink-0 flex items-center gap-0.5">
                      <button
                        type="button"
                        aria-label={copy("dashboard.device_card.rename_save")}
                        disabled={saving || !draft.trim()}
                        onClick={() => commitEdit(d)}
                        className="text-oai-gray-400 hover:text-oai-brand dark:hover:text-white disabled:opacity-30 transition-colors p-0.5"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={copy("dashboard.device_card.rename_cancel")}
                        disabled={saving}
                        onClick={cancelEdit}
                        className="text-oai-gray-400 hover:text-oai-black dark:hover:text-white disabled:opacity-30 transition-colors p-0.5"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  {/* 第二行：置灰的进度条与用量（保持物理高度与拉满） */}
                  <div className="mt-1.5 h-[2px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden opacity-40 select-none">
                    <div
                      className={`h-full rounded-full transition-[width,background-color] duration-700 ease-out ${fillClass}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              ) : (
                /* 3. 正常/展示状态（无绿字绿底，仅通过灰色暗底与失焦虚化对比聚焦，极致素雅） */
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${copy("dashboard.device_filter.aria")}: ${name}`}
                  onClick={() => onSelectDevice?.(isSelected ? "" : d.id)}
                  className={`w-full text-left rounded-md px-2 py-1.5 transition-all duration-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-oai-brand/50 ${itemOpacity} ${
                    isSelected
                      ? "bg-oai-gray-100/70 dark:bg-oai-gray-800/80 text-oai-black dark:text-oai-white"
                      : "bg-transparent hover:bg-oai-gray-50 dark:hover:bg-oai-gray-800/40 text-oai-black dark:text-oai-white"
                  }`}
                >
                  {/* 第一行：左侧名称，右侧用量与 Pencil 渐隐融合 */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <PlatformIcon
                        platform={d.platform}
                        className="h-3.5 w-3.5 shrink-0 text-oai-gray-500 dark:text-oai-gray-400"
                      />
                      <span className="block truncate text-[13px] font-medium text-oai-black dark:text-oai-white" title={name}>
                        {name}
                      </span>
                    </div>

                    {/* 右侧微交互融合区：用量主数字保持标准黑白，百分比数字和点号调淡 (text-oai-gray-400/500) 区分主次 */}
                    <div className="relative shrink-0 flex items-center justify-end w-28 h-4">
                      <span className="text-[13px] font-semibold tabular-nums text-oai-black dark:text-oai-white group-hover:opacity-0 transition-opacity duration-150">
                        {formatCompactNumber(tokens)}
                        <span className="text-oai-gray-400 dark:text-oai-gray-500 font-normal">
                          {DOT_DIVIDER}
                          {percent}
                          {PCT_SIGN}
                        </span>
                      </span>
                      {canRename && (
                        <button
                          type="button"
                          aria-label={copy("dashboard.device_card.rename_aria")}
                          onClick={(e) => {
                            e.stopPropagation(); // 阻止事件冒泡触发选中过滤
                            beginEdit(d);
                          }}
                          className="absolute inset-0 flex items-center justify-end text-oai-gray-400 opacity-0 group-hover:opacity-100 hover:text-oai-brand focus:opacity-100 focus:outline-none transition-opacity duration-150"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* 第二行：细进度条（横向拉满） */}
                  <div className="mt-1.5 h-[2px] bg-oai-gray-100 dark:bg-oai-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-[width,background-color] duration-700 ease-out ${fillClass}`}
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </button>
              )}

              {/* 错误提示 */}
              {errorId === d.id && (
                <div className="px-2 mt-1 text-xs text-red-500 font-medium">
                  {copy("dashboard.device_card.rename_error")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
