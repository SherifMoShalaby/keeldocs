import { Routes } from "@angular/router";

export const routes: Routes = [
  { path: "", component: HomeComponent },
  { path: "drivers", component: DriversComponent, children: [
      { path: ":id", component: DriverDetailComponent },
      { path: ":id/trips", component: DriverTripsComponent },
  ]},
  { path: "admin", loadChildren: () => import("./admin/admin.routes") },
  { path: dynamicPath(), component: MysteryComponent },
];
