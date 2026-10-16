"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { refreshData } from "@/lib/refresh";
import { ensureLoaded, refresh as reload, useStore } from "@/lib/store";
import GlobalSearch, { type SearchTarget } from "./GlobalSearch";
import Header, { type Tab } from "./Header";
import Overview, { type NavTarget, type OpenRef, type OverviewFocus } from "./Overview";
import RefreshButton, { type RefreshState } from "./RefreshButton";
import { TasksView, type Group } from "./TasksView";
import { ProjectsView } from "./ProjectsView";
import { TeamView, type Show } from "./Views";
import TaskEditor from "./TaskEditor";
import WeeklyBrief from "./WeeklyBrief";

function LoadError({ message, loading, compact = false }: { message: string; loading: boolean; compact?: boolean }) {
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg bg-st-red/8 px-4 py-3 text-st-red-strong ${compact ? "mb-5" : "py-6"}`}
    >
      <p className="text-sm font-medium">
        {compact ? "Could not refresh the latest data. " : "Could not load the dashboard. "}
        {message}
      </p>
      <button
        onClick={() => void reload()}
        disabled={loading}
        className="rounded-lg border border-line bg-surface px-3.5 py-2 text-[15px] font-medium text-ink hover:bg-track disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Retrying..." : "Retry"}
      </button>
    </div>
  );
}

/** Scrolls to an element once the new tab has rendered and briefly flashes it. */
function revealLater(id: string) {
  setTimeout(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.animate([{ backgroundColor: "color-mix(in srgb, var(--accent) 35%, transparent)" }, { backgroundColor: "transparent" }], {
      duration: 1600,
      easing: "ease-out",
    });
  }, 80);
}

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("Overview");
  const [task, setTask] = useState<string | null>(null);
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const [tasksFocus, setTasksFocus] = useState<Group | null>(null);
  const [teamShow, setTeamShow] = useState<Show>("all");
  const [teamQuery, setTeamQuery] = useState("");
  const [overviewFocus, setOverviewFocus] = useState<OverviewFocus | null>(null);
  const [brief, setBrief] = useState(false);
  const [refreshState, setRefreshState] = useState<RefreshState>({ status: "idle" });
  const refreshing = useRef(false);
  // The shared arrays are filled from the API by the store; this re-renders the open tab after every load or refetch.
  const store = useStore();
  useEffect(() => {
    ensureLoaded();
  }, []);
  const close = useCallback(() => setTask(null), []);
  const closeBrief = useCallback(() => setBrief(false), []);

  // Projects open in the Projects tab with that project selected; tasks open in a popup.
  const goToProject = useCallback((id: string) => {
    setTask(null);
    setBrief(false);
    setFocusProject(id);
    setTab("Projects");
    window.scrollTo({ top: 0 });
  }, []);
  const open = useCallback(
    (ref: OpenRef) => (ref.kind === "project" ? goToProject(ref.id) : setTask(ref.id)),
    [goToProject],
  );
  const changeTab = (t: Tab) => {
    setTasksFocus(null);
    setTeamShow("all");
    setTeamQuery("");
    setFocusProject(null);
    setOverviewFocus(null);
    setTab(t);
  };

  // Summary cards on the Overview jump to a tab with the matching filter already applied.
  const navigate = (to: NavTarget) => {
    changeTab(to.tab);
    if (to.tab === "Tasks & Deadlines") setTasksFocus(to.focus);
    if (to.tab === "Team") setTeamShow(to.show);
    window.scrollTo({ top: 0 });
  };

  // Navbar search: take the manager to the matching item.
  const onSearch = (t: SearchTarget) => {
    setBrief(false);
    switch (t.kind) {
      case "project":
        return goToProject(t.id);
      case "task":
        return setTask(t.id);
      case "person":
        changeTab("Team");
        setTeamQuery(t.name);
        window.scrollTo({ top: 0 });
        return;
      case "update":
        changeTab("Overview");
        setOverviewFocus({ update: t.update.id, nonce: Date.now() });
        return;
      case "decision":
        changeTab("Overview");
        setOverviewFocus({ decision: t.id, nonce: Date.now() });
        return;
      case "pending":
        changeTab("Overview");
        revealLater(`decision-${t.projectId}`);
        return;
    }
  };

  // Navbar refresh: re-read everything from the backend in place, keeping the tab, filters and open panels.
  const doRefresh = async () => {
    if (refreshing.current) return; // one refresh at a time
    refreshing.current = true;
    setRefreshState((s) => ({ status: "loading", at: "at" in s ? s.at : undefined }));
    try {
      await refreshData();
      setRefreshState({ status: "done", at: new Date(), id: Date.now() });
    } catch (err) {
      setRefreshState((s) => ({
        status: "error",
        message: `Could not refresh: ${err instanceof Error ? err.message : "unknown error"}. Showing the last loaded data.`,
        at: "at" in s ? s.at : undefined,
        id: Date.now(),
      }));
    } finally {
      refreshing.current = false;
    }
  };

  return (
    <>
      <Header
        tab={tab}
        onTab={changeTab}
        actions={
          <>
            <GlobalSearch onSelect={onSearch} />
            <RefreshButton state={refreshState} onRefresh={doRefresh} />
          </>
        }
      />
      <main className="mx-auto w-full max-w-[1800px] flex-1 px-4 py-6 sm:px-8 lg:px-12">
        {!store.loaded && !store.error && (
          <p role="status" className="rounded-xl border border-dashed border-line bg-surface py-12 text-center text-muted">
            Loading your dashboard...
          </p>
        )}
        {!store.loaded && store.error && <LoadError message={store.error} loading={store.loading} />}
        {store.loaded && store.error && <LoadError message={store.error} loading={store.loading} compact />}
        {store.loaded && tab === "Overview" && (
          <Overview onOpen={open} onBrief={() => setBrief(true)} onNavigate={navigate} focus={overviewFocus} />
        )}
        {store.loaded && tab === "Tasks & Deadlines" && <TasksView key={tasksFocus ?? "all"} onOpen={open} initialFocus={tasksFocus} />}
        {store.loaded && tab === "Projects" && <ProjectsView key={focusProject ?? "all"} onOpen={open} focusId={focusProject} />}
        {store.loaded && tab === "Team" && (
          <TeamView key={`${teamShow}|${teamQuery}`} onOpen={open} initialShow={teamShow} initialQuery={teamQuery} />
        )}
      </main>

      {store.loaded && task && <TaskEditor key={task} id={task} onClose={close} onProject={goToProject} />}
      {brief && <WeeklyBrief onClose={closeBrief} onOpen={open} />}
    </>
  );
}
