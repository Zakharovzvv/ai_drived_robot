import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { OperatorProvider } from "./state/OperatorProvider.jsx";
import "./style.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element with id 'root' not found. Check index.html.");
}

const root = ReactDOM.createRoot(rootElement);

root.render(
  <React.StrictMode>
    <BrowserRouter>
      <OperatorProvider>
        <App />
      </OperatorProvider>
    </BrowserRouter>
  </React.StrictMode>
);
