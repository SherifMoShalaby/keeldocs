Rails.application.routes.draw do
  root "pages#home"
  get "health", to: "system#health"

  resources :orders, only: %i[index show create]

  namespace :admin do
    resources :users, except: [:destroy]
    get "stats", to: "dashboard#stats"
  end

  resource :profile, only: [:show, :update]

  mount ActionCable.server => "/cable"
end
