import React, { useEffect, useRef, useState } from "react";

/**
 * AnimatedContainer - 为子元素添加 stagger 入场动画
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - 子元素
 * @param {string} [props.className] - 额外的 CSS 类名
 * @param {number} [props.staggerDelay=100] - 每个子元素之间的延迟(ms)
 * @param {number} [props.initialDelay=0] - 初始延迟(ms)
 */
export function AnimatedContainer({
  children,
  className = "",
  staggerDelay = 100,
  initialDelay = 0,
}) {
  const [visible, setVisible] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), initialDelay);
    return () => clearTimeout(timer);
  }, [initialDelay]);

  const childrenArray = React.Children.toArray(children);

  return (
    <div ref={containerRef} className={className}>
      {childrenArray.map((child, index) => (
        <div
          key={index}
          className={`transition-all duration-500 ease-out ${
            visible
              ? "opacity-100 translate-y-0"
              : "opacity-0 translate-y-4"
          }`}
          style={{
            transitionDelay: visible ? `${index * staggerDelay}ms` : "0ms",
            willChange: "opacity, transform",
          }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}

/**
 * AnimatedCard - 单个卡片的入场动画包装
 *
 * @param {Object} props
 * @param {React.ReactNode} props.children - 子元素
 * @param {string} [props.className] - 额外的 CSS 类名
 * @param {number} [props.delay=0] - 延迟(ms)
 * @param {'fade-up'|'fade-in'|'scale'} [props.animation='fade-up'] - 动画类型
 */
export function AnimatedCard({
  children,
  className = "",
  delay = 0,
  animation = "fade-up",
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  const animationClasses = {
    "fade-up": visible
      ? "opacity-100 translate-y-0"
      : "opacity-0 translate-y-5",
    "fade-in": visible ? "opacity-100" : "opacity-0",
    scale: visible ? "opacity-100 scale-100" : "opacity-0 scale-95",
  };

  return (
    <div
      className={`transition-all duration-500 ease-out ${animationClasses[animation]} ${className}`}
      style={{
        transitionDelay: `${delay}ms`,
        willChange: "opacity, transform",
      }}
    >
      {children}
    </div>
  );
}

/**
 * CountUpNumber - 数字计数动画组件
 *
 * @param {Object} props
 * @param {number|string} props.value - 要显示的数字
 * @param {string} [props.className] - 额外的 CSS 类名
 * @param {number} [props.duration=1000] - 动画持续时间(ms)
 * @param {string} [props.format='compact'] - 格式: 'compact' | 'full' | 'currency'
 */
export function CountUpNumber({
  value,
  className = "",
  duration = 1000,
  format = "compact",
}) {
  const [displayValue, setDisplayValue] = useState("0");
  const [hasAnimated, setHasAnimated] = useState(false);
  const valueRef = useRef(value);

  useEffect(() => {
    // 解析数字
    const numericValue = parseFloat(String(value).replace(/[^\d.-]/g, ""));
    if (!Number.isFinite(numericValue) || numericValue === 0) {
      setDisplayValue(String(value));
      return;
    }

    // 如果值没变且已经动画过，不重复动画
    if (valueRef.current === value && hasAnimated) {
      setDisplayValue(String(value));
      return;
    }

    valueRef.current = value;

    // 简化的计数动画
    const startTime = Date.now();
    const startValue = 0;
    const endValue = numericValue;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // ease-out-quart
      const easeProgress = 1 - Math.pow(1 - progress, 4);
      const currentValue = Math.floor(
        startValue + (endValue - startValue) * easeProgress
      );

      // 格式化显示
      let formatted;
      if (format === "compact") {
        formatted = formatCompact(currentValue);
      } else if (format === "currency") {
        formatted = `$${currentValue.toLocaleString()}`;
      } else {
        formatted = currentValue.toLocaleString();
      }

      setDisplayValue(formatted);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        setDisplayValue(String(value));
        setHasAnimated(true);
      }
    };

    requestAnimationFrame(animate);
  }, [value, duration, format, hasAnimated]);

  return <span className={className}>{displayValue}</span>;
}

// 辅助函数：格式化大数字为紧凑形式
function formatCompact(num) {
  if (num >= 1_000_000_000) {
    return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "B";
  }
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  }
  return num.toString();
}

/**
 * PulseIndicator - 脉冲指示器动画
 *
 * @param {Object} props
 * @param {string} [props.color='bg-oai-brand'] - 颜色类
 * @param {string} [props.size='w-2 h-2'] - 大小类
 */
export function PulseIndicator({
  color = "bg-oai-brand",
  size = "w-2 h-2",
}) {
  return (
    <span className="relative flex">
      <span
        className={`animate-ping absolute inline-flex rounded-full ${color} opacity-75 ${size}`}
      />
      <span
        className={`relative inline-flex rounded-full ${color} ${size}`}
      />
    </span>
  );
}

/**
 * ShimmerLoader - 骨架屏加载动画
 *
 * @param {Object} props
 * @param {string} [props.className] - 额外的 CSS 类名
 */
export function ShimmerLoader({ className = "" }) {
  return (
    <div
      className={`animate-pulse bg-gradient-to-r from-oai-gray-100 via-oai-gray-50 to-oai-gray-100 bg-[length:200%_100%] ${className}`}
      style={{
        animation: "shimmer 1.5s infinite",
      }}
    />
  );
}
