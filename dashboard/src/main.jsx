import React from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { InsforgeAuthProvider } from "./contexts/InsforgeAuthContext.jsx";
import { LocaleProvider } from "./ui/foundation/LocaleProvider.jsx";
import App from "./App.jsx";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/geist-mono/700.css";
import "@fontsource/geist-mono/900.css";
import "./styles.css";

const router = createBrowserRouter([
  { path: "*", element: <App /> },
]);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LocaleProvider>
      <InsforgeAuthProvider>
        <RouterProvider router={router} />
      </InsforgeAuthProvider>
    </LocaleProvider>
  </React.StrictMode>,
);
