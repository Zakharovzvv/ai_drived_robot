import { Outlet } from "react-router-dom";
import Header from "./Header.jsx";
import TabsNav from "./TabsNav.jsx";
import ToastHost from "../components/ToastHost.jsx";
import ConfirmModal from "../components/ConfirmModal.jsx";

export default function AppLayout() {
  return (
    <div className="app-shell">
      <Header />
      <TabsNav />
      <main className="tab-content-container">
        <Outlet />
      </main>
      <ToastHost />
      <ConfirmModal />
    </div>
  );
}
