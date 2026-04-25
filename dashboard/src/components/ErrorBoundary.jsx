import React from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { copy } from "../lib/copy";
import { Button } from "../ui/openai/components/Button.jsx";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (import.meta?.env?.DEV) {
      console.error("ErrorBoundary caught an error:", error, info);
    } else {
      console.error("ErrorBoundary caught an error:", error);
    }
  }

  handleReload() {
    if (typeof window === "undefined") return;
    window.location.reload();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const errorMessage = String(error?.message || error || "");
    const errorLabel = errorMessage
      ? copy("shared.error.prefix", { error: errorMessage })
      : copy("error.boundary.no_details");

    return (
      <div className="flex min-h-screen items-center justify-center bg-oai-white p-6 font-oai text-oai-black antialiased dark:bg-oai-gray-950 dark:text-oai-white">
        <div className="w-full max-w-lg rounded-xl border border-oai-gray-200 bg-white p-6 text-center shadow-sm dark:border-oai-gray-800 dark:bg-oai-gray-900">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 text-amber-600 dark:bg-amber-950/30 dark:text-amber-300">
            <AlertTriangle className="h-5 w-5" aria-hidden />
          </div>
          <div className="mt-4 text-xs font-medium uppercase text-oai-gray-500 dark:text-oai-gray-400">
            {copy("error.boundary.title")}
          </div>
          <h1 className="mt-2 text-xl font-semibold text-oai-black dark:text-white">
            {copy("error.boundary.subtitle")}
          </h1>
          <p className="mt-2 text-sm text-oai-gray-500 dark:text-oai-gray-400">
            {copy("error.boundary.hint")}
          </p>
          <div className="mt-4 max-h-32 overflow-auto rounded-lg border border-oai-gray-200 bg-oai-gray-50 px-3 py-2 text-left text-xs leading-5 text-oai-gray-600 dark:border-oai-gray-800 dark:bg-oai-gray-950 dark:text-oai-gray-300">
            {errorLabel}
          </div>
          <Button
            type="button"
            size="md"
            onClick={this.handleReload}
            className="mt-5"
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            {copy("error.boundary.action.reload")}
          </Button>
        </div>
      </div>
    );
  }
}
