import { createBrowserRouter } from "react-router-dom";

export const adminRouter = createBrowserRouter([
  {
    path: "/admin",
    children: [
      { index: true },
      { path: "stats" },
      { path: "users", children: [{ path: ":uid" }] },
    ],
  },
]);
