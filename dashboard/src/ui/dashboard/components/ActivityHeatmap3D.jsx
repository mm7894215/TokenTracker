import React, { useMemo, useState, useRef, useEffect } from "react";
import { copy } from "../../../lib/copy";


export const PALETTES = {
  emerald: {
    light: ["#ebedf0", "#a7f3d0", "#6ee7b7", "#34d399", "#10b981"],
    dark: ["#2d333b", "#065f46", "#059669", "#10b981", "#34d399"],
    gridColor: { light: "rgba(16, 185, 129, 0.12)", dark: "rgba(52, 211, 153, 0.08)" }
  },
  ocean: {
    light: ["#f1f5f9", "#93c5fd", "#60a5fa", "#3b82f6", "#1d4ed8"],
    dark: ["#1e293b", "#1e3a8a", "#2563eb", "#3b82f6", "#60a5fa"],
    gridColor: { light: "rgba(59, 130, 246, 0.12)", dark: "rgba(96, 165, 250, 0.08)" }
  },
  neon: {
    light: ["#faf5ff", "#ebd5ff", "#c084fc", "#a855f7", "#7e22ce"],
    dark: ["#2e1065", "#581c87", "#8b5cf6", "#a855f7", "#c084fc"],
    gridColor: { light: "rgba(168, 85, 247, 0.12)", dark: "rgba(192, 132, 252, 0.08)" }
  },
  amber: {
    light: ["#fffbeb", "#fde68a", "#f59e0b", "#d97706", "#b45309"],
    dark: ["#451a03", "#78350f", "#b45309", "#d97706", "#f59e0b"],
    gridColor: { light: "rgba(245, 158, 11, 0.12)", dark: "rgba(245, 158, 11, 0.08)" }
  }
};


function shadeColor(hex, factor) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const num = parseInt(m[1], 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const c = (n) => Math.max(0, Math.min(255, Math.round(n * factor)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

function rotatePoint(x, y, z, yaw, pitch) {
  // 1. 绕 Z 轴旋转 yaw (左右自转偏航)
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const x1 = x * cosY - y * sinY;
  const y1 = x * sinY + y * cosY;
  const z1 = z;

  // 2. 绕 X 轴旋转 pitch (上下俯仰)
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const x2 = x1;
  const y2 = y1 * cosP - z1 * sinP;
  const z2 = y1 * sinP + z1 * cosP;

  return { x: x2, y: y2, z: z2 };
}

// 旋转法向量（不含平移）
function rotateVector(x, y, z, yaw, pitch) {
  return rotatePoint(x, y, z, yaw, pitch);
}

// AI 趣味数据洞察文案
export function getAITooltipMessage(level, value) {
  const formatVal = Number(value).toLocaleString();
  if (level >= 4) {
    const index = Math.floor(Math.random() * 3) + 1;
    return copy(`heatmap.3d.voxel.joke.${index}`, { value: formatVal });
  } else if (level === 3) {
    return copy("heatmap.3d.voxel.level3", { value: formatVal });
  } else if (level === 2) {
    return copy("heatmap.3d.voxel.level2", { value: formatVal });
  } else if (level === 1) {
    return copy("heatmap.3d.voxel.level1", { value: formatVal });
  } else {
    return copy("heatmap.3d.voxel.level0");
  }
}

export function ActivityHeatmap3D({
  weeks,
  palette = "auto",
  isDark = false,
  interactive = false,   // 是否为全屏交互 Modal 模式
  autoRotateInit = false, // 默认是否自动缓缓旋转
  onResetViewRef = null,  // 外部句柄，用来重置视角
}) {

  const selectedTheme = PALETTES[palette] || (palette === "auto" ? PALETTES.emerald : null);
  const colors = selectedTheme 
    ? (isDark ? selectedTheme.dark : selectedTheme.light) 
    : (Array.isArray(palette) ? palette : (isDark ? PALETTES.emerald.dark : PALETTES.emerald.light));
  const gridColor = selectedTheme 
    ? (isDark ? selectedTheme.gridColor.dark : selectedTheme.gridColor.light) 
    : (isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)");

  // 1. 视角状态 (yaw, pitch)
  // 经典 Isometric 投影角度：yaw = -45度 (-0.785), pitch = 35.26度 (0.615)
  const defaultYaw = -0.20;
  const defaultPitch = 0.88;

  const [angle, setAngle] = useState({ yaw: defaultYaw, pitch: defaultPitch });
  const [autoRotate, setAutoRotate] = useState(autoRotateInit);
  const [zoom, setZoom] = useState(1.0);

  // 3D grid lines on the floor (z = 0)
  const UNIT_SIZE = interactive ? 13 : 10.5;
  const floorGridLines = useMemo(() => {
    const lines = [];
    const W = weeks.length;
    if (W === 0 || !interactive) return [];
    
    // Horizontal lines (along column direction, parallel to X axis)
    for (let r = 0; r <= 7; r++) {
      const y = (r - 3.5) * UNIT_SIZE;
      const p1 = rotatePoint((-W / 2) * UNIT_SIZE, y, 0, angle.yaw, angle.pitch);
      const p2 = rotatePoint((W / 2) * UNIT_SIZE, y, 0, angle.yaw, angle.pitch);
      lines.push({ d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, key: `horiz-${r}` });
    }
    
    // Vertical lines (along row direction, parallel to Y axis, every 4 weeks)
    for (let c = 0; c <= W; c += 4) {
      const x = (c - W / 2) * UNIT_SIZE;
      const p1 = rotatePoint(x, -3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      const p2 = rotatePoint(x, 3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      lines.push({ d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, key: `vert-${c}` });
    }
    
    if (W % 4 !== 0) {
      const x = (W - W / 2) * UNIT_SIZE;
      const p1 = rotatePoint(x, -3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      const p2 = rotatePoint(x, 3.5 * UNIT_SIZE, 0, angle.yaw, angle.pitch);
      lines.push({ d: `M${p1.x},${p1.y} L${p2.x},${p2.y}`, key: `vert-last` });
    }
    
    return lines;
  }, [weeks.length, angle, UNIT_SIZE, interactive]);


  // 双向绑定重置视角句柄
  useEffect(() => {
    if (onResetViewRef) {
      onResetViewRef.current = {
        reset: () => {
          setAngle({ yaw: defaultYaw, pitch: defaultPitch });
          setAutoRotate(false);
          setZoom(1.0);
          // 触发波浪生长入场动画
          triggerGrowthWave();
        },
        toggleAutoRotate: (val) => {
          setAutoRotate(val);
        }
      };
    }
  }, [onResetViewRef]);

  // 2. 交互与物理惯性 refs
  const svgRef = useRef(null);
  const containerRef = useRef(null);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const angleStartRef = useRef({ yaw: defaultYaw, pitch: defaultPitch });
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastMousePosRef = useRef({ x: 0, y: 0, time: 0 });
  const rafRef = useRef(null);

  // 3. Voxel 高度波浪生长动画
  const [growthWave, setGrowthWave] = useState(0); // 范围 0 到 1
  // RAF handles tracked in refs so we can cancel on unmount / re-trigger.
  // Without these, rapid `interactive` toggles overlapped multiple RAF chains
  // all racing into setGrowthWave, and unmount could fire setState on a dead
  // component.
  const growthRafRef = useRef(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const triggerGrowthWave = () => {
    if (growthRafRef.current) cancelAnimationFrame(growthRafRef.current);
    setGrowthWave(0);
    const start = performance.now();
    const duration = 1200; // 1.2s 生长动画
    const anim = (now) => {
      if (!mountedRef.current) return;
      const elapsed = now - start;
      const progress = Math.min(1, elapsed / duration);
      const ease = 1 - Math.pow(1 - progress, 3);
      setGrowthWave(ease);
      if (progress < 1) {
        growthRafRef.current = requestAnimationFrame(anim);
      } else {
        growthRafRef.current = null;
      }
    };
    growthRafRef.current = requestAnimationFrame(anim);
  };

  useEffect(() => {
    // 首次加载或在 interactive 改变时触发一次生长动画
    triggerGrowthWave();
    return () => {
      if (growthRafRef.current) cancelAnimationFrame(growthRafRef.current);
    };
  }, [interactive]);

  // 4. 自动旋转定时器 — pauses when tab is hidden or user prefers reduced
  // motion, so a backgrounded dashboard doesn't burn CPU re-rendering 365
  // voxels at 60fps.
  useEffect(() => {
    if (!autoRotate || isDraggingRef.current) return;
    if (typeof window === "undefined") return;
    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) return;
    let animRaf;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        animRaf = requestAnimationFrame(tick);
        return;
      }
      setAngle((prev) => ({
        yaw: prev.yaw + 0.002,
        pitch: prev.pitch,
      }));
      animRaf = requestAnimationFrame(tick);
    };
    animRaf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRaf);
  }, [autoRotate]);

  // 5. 拖拽事件监听器
  const handleStart = (clientX, clientY) => {
    if (!interactive) return;
    isDraggingRef.current = true;
    dragStartRef.current = { x: clientX, y: clientY };
    angleStartRef.current = { yaw: angle.yaw, pitch: angle.pitch };
    velocityRef.current = { x: 0, y: 0 };
    lastMousePosRef.current = { x: clientX, y: clientY, time: performance.now() };
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  };

  const handleMove = (clientX, clientY) => {
    if (!isDraggingRef.current) return;
    const dx = clientX - dragStartRef.current.x;
    const dy = clientY - dragStartRef.current.y;

    const now = performance.now();
    const dt = now - lastMousePosRef.current.time;
    if (dt > 0) {
      // 计算滑动速度，为物理阻尼提供初速度
      velocityRef.current = {
        x: (clientX - lastMousePosRef.current.x) / dt,
        y: (clientY - lastMousePosRef.current.y) / dt,
      };
    }
    lastMousePosRef.current = { x: clientX, y: clientY, time: now };

    // 拖动灵敏度：水平拖动改变 yaw，垂直拖动改变 pitch（取负以实现直观的“抓取”推拉方向）
    const sensitivity = 0.005;
    const newYaw = angleStartRef.current.yaw - dx * sensitivity;
    // 限制 pitch 角度范围，避免翻转穿帮
    const maxPitch = Math.PI / 2.3;
    const newPitch = Math.max(-maxPitch, Math.min(maxPitch, angleStartRef.current.pitch - dy * sensitivity));

    setAngle({ yaw: newYaw, pitch: newPitch });
  };

  const handleEnd = () => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    // 开启带阻尼的惯性旋转
    let speedX = -velocityRef.current.x * 12; // 加上负号，与手势拖动方向一致
    let speedY = -velocityRef.current.y * 12;

    const friction = 0.95; // 阻尼系数
    const inertiaTick = () => {
      if (isDraggingRef.current) return;
      speedX *= friction;
      speedY *= friction;

      if (Math.abs(speedX) < 0.01 && Math.abs(speedY) < 0.01) {
        return; // 停止
      }

      setAngle((prev) => {
        const nextYaw = prev.yaw + speedX * 0.005;
        const maxPitch = Math.PI / 2.3;
        const nextPitch = Math.max(-maxPitch, Math.min(maxPitch, prev.pitch + speedY * 0.005));
        return { yaw: nextYaw, pitch: nextPitch };
      });

      rafRef.current = requestAnimationFrame(inertiaTick);
    };
    rafRef.current = requestAnimationFrame(inertiaTick);
  };

  // 6. Hover 数据与精致 Tooltip 状态
  const [hoveredCell, setHoveredCell] = useState(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0, shiftX: 0 });
  const hideTimeoutRef = useRef(null);

  // 卸载时回收防抖定时器
  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
    };
  }, []);

  // 监听鼠标滚轮/触控板双指缩放手势，完全支持 Mac trackpad 双指 pinch-to-zoom
  useEffect(() => {
    if (!interactive || !containerRef.current) return;

    const handleWheel = (e) => {
      // 阻止默认页面滚动行为，仅缩放 3D 热力图
      e.preventDefault();
      
      // 适配 Mac 触控板，双指捏合缩放时的 deltaY 绝对值较小，普通鼠标滚轮 deltaY 较大
      // deltaY < 0 向上滚动 -> 放大 (Zoom In)
      // deltaY > 0 向下滚动 -> 缩小 (Zoom Out)
      const delta = -e.deltaY * 0.0025;
      
      setZoom((prev) => {
        const nextZoom = prev + delta;
        // 限制缩放比例在 0.5 到 3.0 倍之间，避免缩放过小或过大溢出
        return Math.max(0.5, Math.min(3.0, nextZoom));
      });
    };

    const container = containerRef.current;
    // 使用 passive: false 允许 preventDefault 阻止页面滚动
    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [interactive]);

  // 7. 三维空间投影计算
  const cells = useMemo(() => {
    const out = [];
    weeks.forEach((week, weekIdx) => {
      (Array.isArray(week) ? week : []).forEach((cell, dayIdx) => {
        if (!cell) return;
        out.push({
          key: cell.day || `${weekIdx}-${dayIdx}`,
          col: weekIdx,
          row: dayIdx,
          level: cell.level || 0,
          value: cell.value || 0,
          day: cell.day,
          models: cell.models || null,
        });
      });
    });
    return out;
  }, [weeks]);

  // 立方体尺寸常量 (已在顶部声明以供 floorGridLines 使用)
  const GAP = interactive ? 1.8 : 1.5;
  const SIZE = UNIT_SIZE - GAP;
  const HEIGHT_MAX = interactive ? 38 : 28;

  const levelToHeight = (level) => {
    // 0 级保留极薄的边缘厚度以供辨认
    return Math.max(1.8, (Number(level) / 4) * HEIGHT_MAX);
  };

  // 渲染正交投影后的 Voxel 几何面数据
  const projectedCells = useMemo(() => {
    if (cells.length === 0) return [];
    const W = weeks.length;

    return cells.map((c) => {
      const targetH = levelToHeight(c.level);
      // 水波波浪渐变生长：基于距离图表中心的距离产生延迟
      const distFromCenter = Math.sqrt(Math.pow(c.col - W / 2, 2) + Math.pow(c.row - 3.5, 2));
      const maxDist = Math.sqrt(Math.pow(W / 2, 2) + Math.pow(3.5, 2));
      const delay = (distFromCenter / maxDist) * 0.4; // 最大 0.4 延迟
      const cellProgress = Math.min(1, Math.max(0, (growthWave - delay) * (1 / 0.6)));
      
      const h = targetH * cellProgress;

      // 1. 三维空间中的中心坐标
      const xc = (c.col - W / 2) * UNIT_SIZE;
      const yc = (c.row - 3.5) * UNIT_SIZE;

      // 2. 立方体 8 个顶点的 3D 世界坐标
      const half = SIZE / 2;
      const pts = [
        { x: xc - half, y: yc - half, z: 0 }, // 0: 底左前
        { x: xc + half, y: yc - half, z: 0 }, // 1: 底右前
        { x: xc + half, y: yc + half, z: 0 }, // 2: 底右后
        { x: xc - half, y: yc + half, z: 0 }, // 3: 底左后
        { x: xc - half, y: yc - half, z: h }, // 4: 顶左前
        { x: xc + half, y: yc - half, z: h }, // 5: 顶右前
        { x: xc + half, y: yc + half, z: h }, // 6: 顶右后
        { x: xc - half, y: yc + half, z: h }, // 7: 顶左后
      ];

      // 3. 投影 8 个顶点到相机屏幕空间
      const proj = pts.map((p) => rotatePoint(p.x, p.y, p.z, angle.yaw, angle.pitch));

      // 4. 计算立方体中心旋转后的 Z 深度，用于画家算法排序
      const centerProj = rotatePoint(xc, yc, h / 2, angle.yaw, angle.pitch);

      // 5. 6 个面的配置与其在 3D 空间的标准法向量
      const facesConfig = [
        { name: "top", indices: [4, 5, 6, 7], scale: 1.0, normal: [0, 0, 1] },
        { name: "bottom", indices: [3, 2, 1, 0], scale: 0.4, normal: [0, 0, -1] },
        { name: "left", indices: [3, 0, 4, 7], scale: 0.55, normal: [-1, 0, 0] },
        { name: "right", indices: [1, 2, 6, 5], scale: 0.75, normal: [1, 0, 0] },
        { name: "front", indices: [0, 1, 5, 4], scale: 0.85, normal: [0, -1, 0] },
        { name: "back", indices: [2, 3, 7, 6], scale: 0.65, normal: [0, 1, 0] },
      ];

      const baseColor = colors[Math.min(4, Math.max(0, Number(c.level) || 0))];

      // 6. 相机空间内的背向消隐 (Back-face Culling) 与光影 (Shading)
      const renderedFaces = [];
      const lx = 0.35, ly = -0.4, lz = 0.83; // 虚拟光源位置（右上前方）

      facesConfig.forEach((f) => {
        // 计算旋转后的法向量
        const nRot = rotateVector(f.normal[0], f.normal[1], f.normal[2], angle.yaw, angle.pitch);
        
        // 深度大于 0 说明朝向观众（在相机坐标中 z+ 朝向观众）
        if (nRot.z > 0.001) {
          const p0 = proj[f.indices[0]];
          const p1 = proj[f.indices[1]];
          const p2 = proj[f.indices[2]];
          const p3 = proj[f.indices[3]];
          
          // 生成 SVG 路径
          const d = `M${p0.x},${p0.y} L${p1.x},${p1.y} L${p2.x},${p2.y} L${p3.x},${p3.y} Z`;
          
          // 根据朝向和世界光源计算光照强度的漫反射系数
          const dot = nRot.x * lx + nRot.y * ly + nRot.z * lz;
          // 在暗色模式下引入环境光（Ambient Light）保护，防止 3D 柱体侧面因光照系数过低而变成死黑，提升通透质感
          const ambient = isDark ? 0.18 : 0.0;
          const factor = f.scale * (0.82 + 0.28 * Math.max(0, dot)) + ambient;
          
          renderedFaces.push({
            name: f.name,
            d,
            fill: shadeColor(baseColor, factor),
          });
        }
      });

      return {
        ...c,
        centerProj,
        renderedFaces,
      };
    });
  }, [cells, angle, colors, weeks.length, growthWave, UNIT_SIZE, SIZE, HEIGHT_MAX]);

  // 8. 画家算法 (Painter's Algorithm)：由远及近（深度升序）排序渲染
  const sortedCells = useMemo(() => {
    return [...projectedCells].sort((a, b) => a.centerProj.z - b.centerProj.z);
  }, [projectedCells]);

  // 9. 计算 SVG 的包裹框大小
  const bounds = useMemo(() => {
    if (sortedCells.length === 0) return { minX: -100, minY: -100, maxX: 100, maxY: 100 };
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    sortedCells.forEach((c) => {
      // 这里的 centerProj 作为基础范围，加上立方体直径的适当缓冲
      const padding = UNIT_SIZE * 2;
      const x = c.centerProj.x;
      const y = c.centerProj.y;
      
      if (x - padding < minX) minX = x - padding;
      if (x + padding > maxX) maxX = x + padding;
      if (y - padding < minY) minY = y - padding;
      if (y + padding > maxY) maxY = y + padding;
    });

    // 稍微往底部加宽，给高 Voxel 预留空间
    return { minX, minY, maxX, maxY };
  }, [sortedCells, UNIT_SIZE]);

  const pad = 12;
  const width = bounds.maxX - bounds.minX + pad * 2;
  const height = bounds.maxY - bounds.minY + pad * 2;

  // 采用 viewBox 视口中心缩放机制实现平滑的滚轮/触控板手势缩放，且完全兼容 getScreenCTM 投影坐标换算
  const viewBoxWidth = width / zoom;
  const viewBoxHeight = height / zoom;
  const minX = bounds.minX - pad + (width - viewBoxWidth) / 2;
  const minY = bounds.minY - pad + (height - viewBoxHeight) / 2;
  const viewBox = `${minX} ${minY} ${viewBoxWidth} ${viewBoxHeight}`;

  if (cells.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-oai-gray-500">
        {copy("heatmap.empty")}
      </div>
    );
  }

  return (
    <div 
      ref={containerRef}
      className={`relative select-none outline-none ${
        interactive 
          ? "cursor-grab active:cursor-grabbing w-full h-full flex items-center justify-center" 
          : "w-full overflow-hidden flex justify-center"
      }`}
      onMouseDown={(e) => {
        if (!interactive) return;
        handleStart(e.clientX, e.clientY);
        // 绑定 window 级别的拖拽以支持移出 SVG 拖拽
        const moveHandler = (me) => handleMove(me.clientX, me.clientY);
        const upHandler = () => {
          handleEnd();
          window.removeEventListener("mousemove", moveHandler);
          window.removeEventListener("mouseup", upHandler);
        };
        window.addEventListener("mousemove", moveHandler);
        window.addEventListener("mouseup", upHandler);
      }}
      onTouchStart={(e) => {
        if (!interactive || e.touches.length === 0) return;
        handleStart(e.touches[0].clientX, e.touches[0].clientY);
      }}
      onTouchMove={(e) => {
        if (!interactive || e.touches.length === 0) return;
        handleMove(e.touches[0].clientX, e.touches[0].clientY);
      }}
      onTouchEnd={() => {
        if (!interactive) return;
        handleEnd();
      }}
    >
      <svg
        ref={svgRef}
        viewBox={viewBox}
        width={interactive ? "95%" : "100%"}
        height={interactive ? "95%" : "auto"}
        role="img"
        aria-label={copy("heatmap.iso.aria") || "3D interactive activity heatmap"}
        style={{ 
          display: "block", 
          width: "100%", 
          height: "auto", 
          maxWidth: interactive ? "none" : `${width}px`,
          maxHeight: interactive ? "78vh" : "none" 
        }}
        className="transition-transform duration-300 ease-out"
      >
        {/* Floor grid platform */}
        {interactive && floorGridLines.map((line) => (
          <path
            key={line.key}
            d={line.d}
            fill="none"
            stroke={gridColor}
            strokeWidth={0.25}
            strokeDasharray="1.5 2.5"
            strokeLinecap="round"
          />
        ))}

        {sortedCells.map((c) => {
          const isHovered = hoveredCell && hoveredCell.key === c.key;
          return (
            <g 
              key={c.key}
              onMouseEnter={(e) => {
                if (hideTimeoutRef.current) {
                  clearTimeout(hideTimeoutRef.current);
                  hideTimeoutRef.current = null;
                }
                setHoveredCell(c);
                if (interactive && svgRef.current) {
                  // 取得 Voxel 顶面的中心在屏幕上的坐标
                  const projPoint = rotatePoint(
                    (c.col - weeks.length / 2) * UNIT_SIZE,
                    (c.row - 3.5) * UNIT_SIZE,
                    levelToHeight(c.level),
                    angle.yaw,
                    angle.pitch
                  );

                  let screenX = 0;
                  let screenY = 0;
                  const svgEl = svgRef.current;

                  // 优先使用高级的 getScreenCTM 矩阵变换进行像素对齐，完全兼容 preserveAspectRatio 带来的偏移
                  if (containerRef.current && typeof svgEl.createSVGPoint === "function" && typeof svgEl.getScreenCTM === "function") {
                    try {
                      const pt = svgEl.createSVGPoint();
                      pt.x = projPoint.x;
                      pt.y = projPoint.y;
                      const ctm = svgEl.getScreenCTM();
                      if (ctm) {
                        const screenPoint = pt.matrixTransform(ctm);
                        const containerRect = containerRef.current.getBoundingClientRect();
                        screenX = screenPoint.x - containerRect.left;
                        screenY = screenPoint.y - containerRect.top;
                      }
                    } catch (err) {
                      // 降级使用基础比例计算
                      const rect = svgEl.getBoundingClientRect();
                      const viewWidth = bounds.maxX - bounds.minX + pad * 2;
                      const viewHeight = bounds.maxY - bounds.minY + pad * 2;
                      screenX = ((projPoint.x - (bounds.minX - pad)) / viewWidth) * rect.width;
                      screenY = ((projPoint.y - (bounds.minY - pad)) / viewHeight) * rect.height;
                    }
                  } else {
                    // 降级使用基础比例计算
                    const rect = svgEl.getBoundingClientRect();
                    const viewWidth = bounds.maxX - bounds.minX + pad * 2;
                    const viewHeight = bounds.maxY - bounds.minY + pad * 2;
                    screenX = ((projPoint.x - (bounds.minX - pad)) / viewWidth) * rect.width;
                    screenY = ((projPoint.y - (bounds.minY - pad)) / viewHeight) * rect.height;
                  }

                  // 边缘自适应避让算法：卡片半宽设为 140 像素（含安全预留）
                  const halfWidth = 140;
                  let shiftX = 0;
                  const containerWidth = containerRef.current ? containerRef.current.getBoundingClientRect().width : svgEl.getBoundingClientRect().width;
                  if (screenX < halfWidth) {
                    shiftX = halfWidth - screenX;
                  } else if (screenX > containerWidth - halfWidth) {
                    shiftX = (containerWidth - halfWidth) - screenX;
                  }

                  setTooltipPos({
                    x: screenX,
                    y: screenY,
                    shiftX,
                  });
                }
              }}
              onMouseLeave={() => {
                if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
                hideTimeoutRef.current = setTimeout(() => {
                  setHoveredCell(null);
                }, 150);
              }}
              className="transition-all duration-200"
              style={{
                filter: isHovered ? "brightness(1.15) drop-shadow(0 4px 6px rgba(0,0,0,0.15))" : "none",
                cursor: interactive ? "pointer" : "default"
              }}
            >
              {!interactive && c.day && (
                <title>{`${c.day}: ${Number(c.value).toLocaleString()} tokens`}</title>
              )}
              {c.renderedFaces.map((f, idx) => (
                <path
                  key={idx}
                  d={f.d}
                  fill={f.fill}
                  stroke={f.fill} // 补充描边以抹平浮点像素缝隙误差，形成无瑕立体感
                  strokeWidth={0.25}
                  strokeLinejoin="round"
                />
              ))}
            </g>
          );
        })}
      </svg>

      {/* 10. 交互模式下的 3D 浮动 Tooltip（解耦零尺寸锚点 + 零抖动边缘自适应避让） */}
      {interactive && hoveredCell && (
        <div
          onMouseEnter={() => {
            if (hideTimeoutRef.current) {
              clearTimeout(hideTimeoutRef.current);
              hideTimeoutRef.current = null;
            }
          }}
          onMouseLeave={() => {
            if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
            hideTimeoutRef.current = setTimeout(() => {
              setHoveredCell(null);
            }, 150);
          }}
          className="absolute z-[9999] w-0 h-0 transition-all duration-100 ease-out"
          style={{
            left: `${tooltipPos.x}px`,
            top: `${tooltipPos.y}px`,
          }}
        >
          {/* Tooltip 玻璃外框（通过 absolute 定位挂载在锚点上方，内容向上自然生长，底边雷打不动） */}
          <div 
            className="absolute left-0 bottom-[10px] backdrop-blur-md bg-white/90 dark:bg-oai-gray-900/90 border border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-xl rounded-xl p-3.5 max-w-[280px] min-w-[200px] flex flex-col gap-2 animate-in fade-in zoom-in-95 duration-100"
            style={{
              transform: `translateX(calc(-50% + ${tooltipPos.shiftX}px))`,
            }}
          >
            {/* 顶栏 */}
            <div className="flex items-center justify-between border-b border-oai-gray-100 dark:border-oai-gray-800/80 pb-1.5">
              <span className="text-[11px] font-semibold text-oai-gray-500 dark:text-oai-gray-400">
                {hoveredCell.day}
              </span>
              {(() => {
                // 解决暗色模式下 Level 0 徽章使用极暗灰色导致文字完全不可见的问题
                const badgeColor = hoveredCell.level === 0 
                  ? (isDark ? "#9ca3af" : "#6b7280") 
                  : colors[hoveredCell.level];
                return (
                  <span 
                    className="text-[10px] px-2 py-0.5 rounded-full font-medium"
                    style={{
                      backgroundColor: badgeColor + "22",
                      color: badgeColor,
                      border: `1px solid ${badgeColor}44`
                    }}
                  >
                    Level {hoveredCell.level}
                  </span>
                );
              })()}
            </div>
            
            {/* 内容 */}
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline gap-1">
                <span className="text-lg font-bold text-oai-gray-900 dark:text-white leading-none">
                  {Number(hoveredCell.value).toLocaleString()}
                </span>
                <span className="text-[10px] text-oai-gray-400 uppercase tracking-wider font-semibold">
                  Tokens
                </span>
              </div>
              
              {hoveredCell.models && Object.keys(hoveredCell.models).length > 0 ? (
                <div className="mt-1.5 border-t border-oai-gray-100 dark:border-oai-gray-800/60 pt-2 flex flex-col gap-1.5">
                  <div className="text-[10px] font-semibold text-oai-gray-400 dark:text-oai-gray-500 uppercase tracking-wider">
                    Model Breakdown
                  </div>
                  <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto pr-1.5 scrollbar-thin">
                    {Object.entries(hoveredCell.models)
                      .map(([name, val]) => ({ name, val: Number(val) }))
                      .sort((a, b) => b.val - a.val)
                      .map(({ name, val }) => {
                        const total = Number(hoveredCell.value) || 1;
                        const pct = Math.round((val / total) * 100);
                        return (
                          <div key={name} className="flex flex-col gap-1">
                            <div className="flex items-center justify-between text-[11px] gap-3">
                              <span className="font-medium text-oai-gray-750 dark:text-oai-gray-200 truncate max-w-[120px]" title={name}>
                                {name}
                              </span>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <span className="font-mono text-oai-gray-900 dark:text-oai-gray-100 font-semibold">
                                  {val.toLocaleString()}
                                </span>
                                <span className="text-[9px] text-oai-gray-450 dark:text-oai-gray-500 min-w-[28px] text-right font-medium">
                                  {pct}%
                                </span>
                              </div>
                            </div>
                            {/* Visual Progress Bar Accent */}
                            <div className="w-full h-1 bg-oai-gray-100 dark:bg-oai-gray-800/85 rounded-full overflow-hidden">
                              <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{
                                  width: `${pct}%`,
                                  backgroundColor: colors[4],
                                  boxShadow: `0 0 4px ${colors[4]}55`
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              ) : (
                <p className="text-[11px] text-oai-gray-600 dark:text-oai-gray-300 leading-relaxed font-normal mt-1 border-t border-dashed border-oai-gray-100 dark:border-oai-gray-800/60 pt-1.5">
                  {getAITooltipMessage(hoveredCell.level, hoveredCell.value)}
                </p>
              )}
            </div>
          </div>
          
          {/* 倒三角小尾巴（绝对定位且 z-index 偏下，上部分优雅重合遮挡，100% 精准指向 Voxel 中心） */}
          <div 
            className="absolute bottom-[6px] left-0 -translate-x-1/2 w-2.5 h-2.5 rotate-45 bg-white dark:bg-oai-gray-900 border-r border-b border-oai-gray-200/50 dark:border-oai-gray-800/50 shadow-sm"
            style={{ marginBottom: "1px" }}
          />
        </div>
      )}
    </div>
  );
}

export default ActivityHeatmap3D;
