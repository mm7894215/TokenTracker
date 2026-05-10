import React from "react";

/**
 * Input - OpenAI 风格的输入框组件
 *
 * @param {Object} props
 * @param {string} [props.value] - 输入值
 * @param {function} [props.onChange] - 值变化事件处理函数
 * @param {string} [props.placeholder] - 占位符文本
 * @param {boolean} [props.disabled=false] - 是否禁用
 * @param {string} [props.type='text'] - 输入类型
 * @param {string} [props.label] - 标签文本
 * @param {string} [props.error] - 错误信息
 * @param {string} [props.className] - 额外的 CSS 类名
 */
export function Input({
  value,
  onChange,
  placeholder,
  disabled = false,
  type = "text",
  label,
  error,
  className = "",
  ...props
}) {
  const baseStyles =
    "w-full bg-oai-white dark:bg-oai-gray-900 border border-oai-gray-300 dark:border-oai-gray-700 rounded-md text-oai-black dark:text-oai-white placeholder-oai-gray-400 dark:placeholder-oai-gray-500 transition-all duration-200 focus:outline-none focus:border-oai-brand dark:focus:border-oai-brand focus:ring-1 focus:ring-oai-brand/30";

  const disabledStyles = disabled
    ? "bg-oai-gray-50 dark:bg-oai-gray-800 text-oai-gray-400 dark:text-oai-gray-400 cursor-not-allowed"
    : "";

  const errorStyles = error
    ? "border-oai-error focus:border-oai-error focus:ring-oai-error/30"
    : "";

  const mergedClassName = `${baseStyles} ${disabledStyles} ${errorStyles} h-10 px-3 text-sm ${className}`;

  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-oai-gray-700 dark:text-oai-gray-300 mb-1.5 transition-colors duration-200">
          {label}
        </label>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        className={mergedClassName}
        {...props}
      />
      {error && <p className="mt-1.5 text-sm text-oai-error">{error}</p>}
    </div>
  );
}
