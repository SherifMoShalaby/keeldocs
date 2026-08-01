import { Routes, Route } from "react-router-dom";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="owners" element={<OwnersLayout />}>
        <Route index element={<OwnerList />} />
        <Route path=":ownerId" element={<OwnerDetail />} />
        <Route path=":ownerId/edit" element={<OwnerEdit />} />
      </Route>
      <Route path="/about" element={<About />} />
      <Route path={dynamicPath()} element={<Mystery />} />
    </Routes>
  );
}
