Rails.application.routes.draw do
  resources :orders
  resources :shipments
  get "/health", to: "health#show"
  root "home#index"
end
