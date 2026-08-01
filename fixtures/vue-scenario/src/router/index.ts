import { createRouter, createWebHistory } from "vue-router";

const routes = [
  { path: "/", component: Home },
  { path: "/rides", component: RideList, children: [
      { path: ":rideId", component: RideDetail },
  ]},
  { path: "/settings", component: Settings },
];

export default createRouter({ history: createWebHistory(), routes });
